const { ipcRenderer } = require('electron');

let mode = 'select';
let selected = null;
let activeAnnotationPointer = null;
const interactionTrail = [];

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

function selectorFor(element) {
  if (!element || element.nodeType !== 1) return '';
  if (element.id) return `#${cssEscape(element.id)}`;
  const parts = [];
  let current = element;
  while (current && current.nodeType === 1 && current !== document.body && parts.length < 5) {
    let part = current.tagName.toLowerCase();
    const classes = [...current.classList].filter(c => !/^lemon-/.test(c)).slice(0, 2);
    if (classes.length) part += `.${classes.map(cssEscape).join('.')}`;
    const siblings = current.parentElement ? [...current.parentElement.children].filter(s => s.tagName === current.tagName) : [];
    if (siblings.length > 1 && !classes.length) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    parts.unshift(part);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

function clearOutline() {
  if (selected) selected.style.outline = selected.dataset.lemonOriginalOutline || '';
}

function isScrollable(element) {
  if (!(element instanceof Element)) return false;
  const style = getComputedStyle(element);
  const vertical = /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
  const horizontal = /(auto|scroll|overlay)/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1;
  return vertical || horizontal;
}

function scrollContainersFor(element) {
  const containers = [];
  const seen = new Set();
  const add = (container) => {
    if (!(container instanceof Element)) return;
    const selector = selectorFor(container) || 'html';
    if (seen.has(selector)) return;
    seen.add(selector);
    containers.push(container);
  };
  let current = element;
  while (current && current !== document.documentElement) {
    if (isScrollable(current)) add(current);
    current = current.parentElement;
  }
  // 无论当前标注是否在内部横向滚动轨道中，页面根节点的纵向滚动也会影响它。
  add(document.scrollingElement || document.documentElement);
  return containers;
}

function scrollContextsFor(element) {
  return scrollContainersFor(element).map(container => ({
    selector: selectorFor(container) || 'html',
    top: container.scrollTop || 0,
    left: container.scrollLeft || 0
  }));
}

function scrollByAt(point, deltaX, deltaY) {
  const target = document.elementFromPoint(point?.x || 0, point?.y || 0) || document.body;
  const containers = scrollContainersFor(target);
  const moved = [];
  const emitScroll = (container) => {
    const payload = { selector: selectorFor(container) || 'html', top: container.scrollTop || 0, left: container.scrollLeft || 0 };
    ipcRenderer.sendToHost('prototype-scroll', payload);
    return payload;
  };
  const apply = (container, axis, amount) => {
    if (!amount) return amount;
    const property = axis === 'x' ? 'scrollLeft' : 'scrollTop';
    const maximum = axis === 'x' ? container.scrollWidth - container.clientWidth : container.scrollHeight - container.clientHeight;
    const before = container[property];
    container[property] = Math.max(0, Math.min(maximum, before + amount));
    const changed = container[property] - before;
    if (changed) moved.push(emitScroll(container));
    return amount - changed;
  };
  let remainingX = deltaX || 0;
  let remainingY = deltaY || 0;
  // 鼠标滚轮通常只有 deltaY。若光标位于仅横向滚动的轨道，把该位移转换为横向移动。
  const nearest = containers[0];
  if (!remainingX && remainingY && nearest && nearest.scrollWidth > nearest.clientWidth + 1 && nearest.scrollHeight <= nearest.clientHeight + 1) {
    remainingX = remainingY;
    remainingY = 0;
  }
  containers.forEach(container => {
    remainingX = apply(container, 'x', remainingX);
    remainingY = apply(container, 'y', remainingY);
  });
  // 少数原型把横向轨道置于 DOM 链的兄弟节点。回退到光标位置可见的横向容器。
  if (remainingX) {
    const fallback = [...document.querySelectorAll('*')].find(element => {
      if (!isScrollable(element) || element.scrollWidth <= element.clientWidth + 1) return false;
      const rect = element.getBoundingClientRect();
      return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
    });
    if (fallback && !containers.includes(fallback)) remainingX = apply(fallback, 'x', remainingX);
  }
  return { moved, remainingX, remainingY, containers: containers.map(container => selectorFor(container) || 'html') };
}

function pageLocationFor(element) {
  const area = element.closest('[aria-label], [data-component], section, article, main, header, nav, aside, [role]');
  const pageRoot = element.closest('[data-mpatch-page-id]');
  const componentRoot = element.closest('[data-mpatch-component-id]');
  const semanticElement = element.closest('[data-mpatch-element-id]');
  const directHeading = area && [...area.children].find(child => /^(H1|H2|H3)$/.test(child.tagName));
  const areaLabel = area?.getAttribute('aria-label') || area?.dataset.component || directHeading?.innerText || selectorFor(area);
  const parent = element.parentElement;
  const siblingIndex = parent ? [...parent.children].indexOf(element) + 1 : 1;
  return {
    pageTitle: document.title.replace(/\s+/g, ' ').trim().slice(0, 80),
    pageId: pageRoot?.dataset.mpatchPageId || '',
    pageName: pageRoot?.dataset.mpatchPageName || '',
    pageType: pageRoot?.dataset.mpatchPageType || '',
    pageState: pageRoot?.dataset.mpatchState || '',
    componentId: componentRoot?.dataset.mpatchComponentId || '',
    componentName: componentRoot?.dataset.mpatchComponentName || '',
    elementId: semanticElement?.dataset.mpatchElementId || '',
    elementName: semanticElement?.dataset.mpatchElementName || '',
    area: (areaLabel || '页面主体').replace(/\s+/g, ' ').trim().slice(0, 100),
    nearbyText: (parent?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100),
    siblingIndex
  };
}

function sendElement(element, point, allowPageRoot = false) {
  if (!element) return;
  if (!allowPageRoot && (element === document.documentElement || element === document.body)) return;
  clearOutline();
  selected = element;
  selected.dataset.lemonOriginalOutline = selected.style.outline || '';
  selected.style.outline = '2px solid #d7ff56';
  selected.style.outlineOffset = '2px';
  const rect = element.getBoundingClientRect();
  const parent = element.parentElement;
  const style = getComputedStyle(element);
  ipcRenderer.sendToHost('element-selected', {
    selector: selectorFor(element),
    tag: element.tagName.toLowerCase(),
    text: (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    snippet: element.outerHTML.replace(/\s+/g, ' ').slice(0, 420),
    parentSelector: selectorFor(parent),
    pageLocation: pageLocationFor(element),
    stateContext: {
      url: `${location.pathname}${location.search}${location.hash}`,
      hash: location.hash,
      interactionTrail: interactionTrail.slice(-5)
    },
    scrollContexts: scrollContextsFor(element),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    point,
    styleHint: { display: style.display, position: style.position, fontSize: style.fontSize, color: style.color }
  });
}

// 预览页开启了 contextIsolation，宿主不能通过 executeJavaScript 访问本文件定义的
// window 属性。改用 Electron 的 webview.send → ipcRenderer.on 通道与宿主通信。
ipcRenderer.on('mpatch:set-mode', (_event, nextMode) => {
  mode = nextMode;
  activeAnnotationPointer = null;
});
ipcRenderer.on('mpatch:select-at', (_event, point) => {
  try {
    const x = Math.round(point?.x || 0);
    const y = Math.round(point?.y || 0);
    sendElement(document.elementFromPoint(x, y) || document.body, { x, y }, true);
  } catch (error) {
    ipcRenderer.sendToHost('inspector-error', { message: error.message, stack: error.stack });
  }
});
ipcRenderer.on('mpatch:scroll-by', (_event, payload) => {
  try {
    const result = scrollByAt(payload?.point, payload?.deltaX, payload?.deltaY);
    ipcRenderer.sendToHost('wheel-forwarded', { deltaX: payload?.deltaX || 0, deltaY: payload?.deltaY || 0, shiftKey: Boolean(payload?.shiftKey), ...result });
  }
  catch (error) { ipcRenderer.sendToHost('inspector-error', { message: error.message, stack: error.stack }); }
});

function annotationPoint(event) {
  return { x: Math.round(event.clientX), y: Math.round(event.clientY) };
}

// 画笔事件在原型 webview 内采集；不要监听或阻止 wheel，让 macOS 触摸板始终走浏览器
// 原生滚动链（含嵌套横向轨道、惯性和双轴滚动）。
document.addEventListener('pointerdown', (event) => {
  if (!['circle', 'brush', 'insert'].includes(mode) || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const point = annotationPoint(event);
  if (mode === 'insert') {
    ipcRenderer.sendToHost('annotation-input', { phase: 'insert', kind: 'insert', point });
    return;
  }
  activeAnnotationPointer = { id: event.pointerId, kind: mode };
  event.target?.setPointerCapture?.(event.pointerId);
  ipcRenderer.sendToHost('annotation-input', { phase: 'start', kind: mode, point });
}, true);

document.addEventListener('pointermove', (event) => {
  if (!activeAnnotationPointer || event.pointerId !== activeAnnotationPointer.id) return;
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.sendToHost('annotation-input', { phase: 'move', kind: activeAnnotationPointer.kind, point: annotationPoint(event) });
}, true);

['pointerup', 'pointercancel'].forEach((eventName) => {
  document.addEventListener(eventName, (event) => {
    if (!activeAnnotationPointer || event.pointerId !== activeAnnotationPointer.id) return;
    event.preventDefault();
    event.stopPropagation();
    const kind = activeAnnotationPointer.kind;
    activeAnnotationPointer = null;
    ipcRenderer.sendToHost('annotation-input', { phase: eventName === 'pointerup' ? 'end' : 'cancel', kind, point: annotationPoint(event) });
  }, true);
});

document.addEventListener('click', (event) => {
  if (mode !== 'select') return;
  event.preventDefault();
  event.stopPropagation();
  sendElement(event.target, { x: event.clientX, y: event.clientY });
}, true);

// 预览状态下的业务点击不被拦截。只记录最近的到达路径，供后续标注冻结为状态上下文。
document.addEventListener('click', (event) => {
  if (mode !== 'idle') return;
  const element = event.target instanceof Element ? event.target : null;
  if (!element) return;
  window.setTimeout(() => {
    const text = (element.getAttribute('aria-label') || element.innerText || element.textContent || element.tagName)
      .replace(/\s+/g, ' ').trim().slice(0, 48);
    interactionTrail.push({ action: text || '页面交互', selector: selectorFor(element) });
    if (interactionTrail.length > 5) interactionTrail.shift();
    ipcRenderer.sendToHost('prototype-state', {
      pageLocation: pageLocationFor(element),
      url: `${location.pathname}${location.search}${location.hash}`,
      interactionTrail: interactionTrail.slice()
    });
  }, 0);
}, false);

// 捕获所有滚动容器（不只 window）。宿主根据同一容器的滚动差值移动对应标注。
document.addEventListener('scroll', (event) => {
  const container = event.target === document ? (document.scrollingElement || document.documentElement) : event.target;
  if (!(container instanceof Element)) return;
  ipcRenderer.sendToHost('prototype-scroll', {
    selector: selectorFor(container) || 'html',
    top: container.scrollTop || 0,
    left: container.scrollLeft || 0
  });
}, true);
