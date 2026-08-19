const state = {
  project: null,
  mode: 'idle',
  target: null,
  changes: [],
  annotations: [],
  scrollPositions: new Map(),
  selectedAnnotationId: null,
  drawing: null,
  webviewReady: false,
  lastPreviewSize: '',
  prototypeState: null,
  interactionTrail: []
};

const $ = (id) => document.getElementById(id);
const view = $('prototypeView');
const stage = $('previewStage');
const layer = $('annotationLayer');
const intent = $('intent');
const operation = $('operation');
const modeHelp = $('modeHelp');
const operationLabels = { modify: '修改', insert: '插入', delete: '删除', optimize: '优化' };
const modeCopy = {
  idle: '交互预览已开启：可直接操作原型；选择工具后再定位或圈改。',
  select: '点击页面元素；点击已有圈选或涂抹，可单独删除。',
  circle: '拖动圈选一个区域；松开后输入你的修改需求。',
  brush: '涂抹需要弱化、删除或调整的区域；松开后补充需求。',
  insert: '点击你希望插入内容附近的位置，再描述要新增什么。'
};

function logDiagnostic(message) {
  window.lemon.logDiagnostic?.(message).catch(() => {});
}

function resizePreview() {
  if (stage.classList.contains('hidden')) return;
  const bounds = stage.getBoundingClientRect();
  const width = Math.max(1, Math.round(bounds.width));
  const height = Math.max(1, Math.round(bounds.height));
  const signature = `${width}x${height}`;
  // Electron webview 是原生控件，除 CSS 外还必须写入像素级 width/height 属性，
  // 否则会回退到默认 300px 高度。
  view.style.width = `${width}px`;
  view.style.height = `${height}px`;
  view.setAttribute('width', String(width));
  view.setAttribute('height', String(height));
  if (state.lastPreviewSize !== signature) {
    state.lastPreviewSize = signature;
    logDiagnostic(`preview-resize stage=${signature} webview-css=${view.style.width}×${view.style.height} attrs=${view.getAttribute('width')}×${view.getAttribute('height')}`);
  }
}

function hasProject() { return Boolean(state.project); }
function escapeHtml(value) { return String(value || '').replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c])); }
function short(value, length = 85) { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > length ? `${text.slice(0, length - 1)}…` : text; }

async function openProject() {
  const project = await window.lemon.openHtml();
  if (!project) return;
  state.project = project;
  state.target = null;
  state.changes = [];
  state.annotations = [];
  state.scrollPositions.clear();
  state.prototypeState = null;
  state.interactionTrail = [];
  clearSelectedAnnotation();
  state.webviewReady = false;
  $('fileInfo').textContent = project.filePath;
  $('refreshPrototype').disabled = false;
  $('emptyState').classList.add('hidden');
  stage.classList.remove('hidden');
  requestAnimationFrame(resizePreview);
  renderAnnotations();
  resetTarget();
  renderChanges();
  const preloadUrl = await window.lemon.getWebviewPreload();
  view.setAttribute('preload', preloadUrl);
  view.src = project.fileUrl;
}

function resetTarget() {
  state.target = null;
  $('targetName').textContent = '尚未选择元素';
  $('targetStatus').classList.remove('selected');
  $('targetCard').innerHTML = '<p>在左侧选择工具后，在原型上点选或圈选位置。</p>';
}

function selectTarget(target, annotation) {
  if (!target) return;
  const receivedContexts = target.scrollContexts?.length
    ? target.scrollContexts
    : target.scrollContext ? [target.scrollContext] : [];
  if (annotation?.id && receivedContexts.length) {
    const savedAnnotation = state.annotations.find(item => item.id === annotation.id);
    if (savedAnnotation) {
      savedAnnotation.scrollContexts = receivedContexts.map(context => ({
        selector: context.selector,
        initialTop: context.top,
        initialLeft: context.left
      }));
      receivedContexts.forEach(context => state.scrollPositions.set(context.selector, context));
      updateAnnotationPositions();
    }
  }
  state.target = { ...target, annotation };
  $('targetName').textContent = target.text ? short(target.text, 28) : `${target.tag || '区域'} 元素`;
  $('targetStatus').classList.add('selected');
  $('targetCard').innerHTML = `<strong>${escapeHtml(target.text || `${target.tag || '页面'} 区域`)}</strong><code>${escapeHtml(target.selector || target.parentSelector || '视觉标注区域')}</code>`;
  if (state.mode === 'select') {
    setMode('idle');
    modeHelp.textContent = '已选择组件。你可以描述需求并加入修改清单，或继续操作原型。';
  }
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tool').forEach(button => button.classList.toggle('active', button.dataset.tool === mode));
  modeHelp.textContent = modeCopy[mode];
  // 标注 SVG 永远不接管预览空白区域；只有选择模式下已有笔迹可被点击。
  // 新建标注的指针输入由 webview 内部采集，从而不阻断原型的原生滚动。
  layer.classList.toggle('selecting', mode === 'select');
  layer.style.pointerEvents = 'none';
  if (state.webviewReady) {
    try { view.send('mpatch:set-mode', mode); }
    catch (error) { logDiagnostic(`set-mode-error ${error.message}`); }
  }
}

function selectAnnotation(id) {
  state.selectedAnnotationId = id;
  layer.querySelectorAll('[data-annotation-id]').forEach(node => node.classList.toggle('is-selected', node.dataset.annotationId === id));
  $('deleteSelectedAnnotation').disabled = !id;
  if (id) modeHelp.textContent = '已选中笔迹。可删除，或切换工具继续标注。';
}

function clearSelectedAnnotation() {
  state.selectedAnnotationId = null;
  $('deleteSelectedAnnotation').disabled = true;
  layer.querySelectorAll('.is-selected').forEach(node => node.classList.remove('is-selected'));
}

function createSvg(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  Object.entries(attrs).forEach(([name, value]) => node.setAttribute(name, value));
  layer.appendChild(node);
  return node;
}

function annotationTransform(annotation) {
  const contexts = annotation.scrollContexts?.length
    ? annotation.scrollContexts
    : annotation.scrollContext ? [annotation.scrollContext] : [];
  if (!contexts.length) return '';
  const delta = contexts.reduce((sum, context) => {
    const position = state.scrollPositions.get(context.selector);
    if (!position) return sum;
    sum.x += context.initialLeft - position.left;
    sum.y += context.initialTop - position.top;
    return sum;
  }, { x: 0, y: 0 });
  const x = Math.round(delta.x);
  const y = Math.round(delta.y);
  return x || y ? `translate(${x} ${y})` : '';
}

function updateAnnotationPositions() {
  layer.querySelectorAll('[data-annotation-id]').forEach(node => {
    const annotation = state.annotations.find(item => item.id === node.dataset.annotationId);
    if (!annotation) return;
    const transform = annotationTransform(annotation);
    if (transform) node.setAttribute('transform', transform);
    else node.removeAttribute('transform');
  });
}

function renderAnnotations() {
  layer.innerHTML = '';
  state.annotations.forEach(annotation => {
    annotation.id ||= crypto.randomUUID();
    if (annotation.type === 'circle') {
      createSvg('ellipse', {
        class: 'annotation-shape',
        'data-annotation-id': annotation.id,
        cx: annotation.x + annotation.width / 2,
        cy: annotation.y + annotation.height / 2,
        rx: annotation.width / 2,
        ry: annotation.height / 2,
        transform: annotationTransform(annotation)
      });
    }
    if (annotation.type === 'brush') createSvg('path', { class: 'annotation-path', 'data-annotation-id': annotation.id, d: annotation.path, transform: annotationTransform(annotation) });
    if (annotation.type === 'insert') createSvg('circle', { class: 'annotation-shape', 'data-annotation-id': annotation.id, cx: annotation.x, cy: annotation.y, r: 11, transform: annotationTransform(annotation) });
  });
  if (state.selectedAnnotationId) selectAnnotation(state.selectedAnnotationId);
}

function pickAt(point, annotation) {
  if (!state.webviewReady) return;
  if (annotation) state.pendingAnnotation = annotation;
  try {
    view.send('mpatch:select-at', { x: Math.round(point.x), y: Math.round(point.y) });
  } catch (error) {
    logDiagnostic(`pick-target-error ${error.message}`);
    state.pendingAnnotation = null;
  }
}

function finishDrawing() {
  const drawing = state.drawing;
  state.drawing = null;
  if (!drawing) return;
  if (drawing.kind === 'brush' && drawing.points.length < 2) { drawing.node.remove(); return; }
  const annotation = drawing.kind === 'circle'
    ? { id: crypto.randomUUID(), type: 'circle', x: Math.round(drawing.start.x), y: Math.round(drawing.start.y), width: Math.round(Math.abs(drawing.end.x - drawing.start.x)), height: Math.round(Math.abs(drawing.end.y - drawing.start.y)) }
    : { id: crypto.randomUUID(), type: 'brush', path: drawing.node.getAttribute('d') };
  state.annotations.push(annotation);
  drawing.node.dataset.annotationId = annotation.id;
  selectAnnotation(annotation.id);
  const center = drawing.kind === 'circle'
    ? { x: (drawing.start.x + drawing.end.x) / 2, y: (drawing.start.y + drawing.end.y) / 2 }
    : drawing.points[Math.floor(drawing.points.length / 2)];
  pickAt(center, annotation);
  setMode('idle');
  intent.focus();
}

function startAnnotation(kind, point) {
  if (!hasProject()) return;
  if (kind === 'insert') {
    const annotation = { id: crypto.randomUUID(), type: 'insert', x: Math.round(point.x), y: Math.round(point.y) };
    createSvg('circle', { class: 'annotation-shape', 'data-annotation-id': annotation.id, cx: point.x, cy: point.y, r: 14 });
    state.annotations.push(annotation);
    pickAt(point, annotation);
    selectAnnotation(annotation.id);
    operation.value = 'insert';
    setMode('idle');
    intent.focus();
    return;
  }
  if (!['circle', 'brush'].includes(kind)) return;
  if (kind === 'circle') {
    const node = createSvg('ellipse', { class: 'annotation-shape', cx: point.x, cy: point.y, rx: 1, ry: 1 });
    state.drawing = { kind: 'circle', start: point, end: point, node };
  } else {
    const node = createSvg('path', { class: 'annotation-path', d: `M ${point.x} ${point.y}` });
    state.drawing = { kind: 'brush', points: [point], node };
  }
}

function moveAnnotation(point) {
  const drawing = state.drawing;
  if (!drawing) return;
  if (drawing.kind === 'circle') {
    drawing.end = point;
    drawing.node.setAttribute('cx', (drawing.start.x + point.x) / 2);
    drawing.node.setAttribute('cy', (drawing.start.y + point.y) / 2);
    drawing.node.setAttribute('rx', Math.abs(point.x - drawing.start.x) / 2);
    drawing.node.setAttribute('ry', Math.abs(point.y - drawing.start.y) / 2);
  } else {
    drawing.points.push(point);
    drawing.node.setAttribute('d', `${drawing.node.getAttribute('d')} L ${point.x} ${point.y}`);
  }
}

layer.addEventListener('pointerdown', event => {
  if (state.mode !== 'select') return;
  const annotationNode = event.target.closest?.('[data-annotation-id]');
  if (!annotationNode) return;
  event.preventDefault();
  event.stopPropagation();
  selectAnnotation(annotationNode.dataset.annotationId);
  setMode('idle');
});

view.addEventListener('dom-ready', () => {
  state.webviewReady = true;
  resizePreview();
  setMode(state.mode);
  renderAnnotations();
  view.executeJavaScript(`({
    viewport: { width: window.innerWidth, height: window.innerHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    body: { width: document.body?.scrollWidth, height: document.body?.scrollHeight, background: getComputedStyle(document.body).backgroundColor }
  })`).then(metrics => logDiagnostic(`prototype-metrics ${JSON.stringify(metrics)}`)).catch(error => logDiagnostic(`prototype-metrics-error ${error.message}`));
});

function refreshPrototype() {
  if (!hasProject() || !state.webviewReady) return;
  state.webviewReady = false;
  state.pendingAnnotation = null;
  resetTarget();
  modeHelp.textContent = '正在重新加载原型中的 HTML、CSS、JS 和本地资源…';
  try {
    view.reloadIgnoringCache();
  } catch (error) {
    logDiagnostic(`refresh-error ${error.message}`);
    modeHelp.textContent = '刷新失败，请重新打开该 HTML 文件。';
  }
}

new ResizeObserver(resizePreview).observe(stage);
window.addEventListener('resize', resizePreview);

view.addEventListener('ipc-message', event => {
  if (event.channel === 'annotation-input') {
    const input = event.args[0];
    if (!input?.point) return;
    if (input.phase === 'start' || input.phase === 'insert') startAnnotation(input.kind, input.point);
    if (input.phase === 'move') moveAnnotation(input.point);
    if (input.phase === 'end' || input.phase === 'cancel') finishDrawing();
    return;
  }
  if (event.channel === 'element-selected') {
    selectTarget(event.args[0], state.pendingAnnotation || null);
    state.pendingAnnotation = null;
    return;
  }
  if (event.channel === 'prototype-state') {
    const snapshot = event.args[0];
    state.prototypeState = snapshot || null;
    state.interactionTrail = snapshot?.interactionTrail || [];
    return;
  }
  if (event.channel === 'prototype-scroll') {
    const position = event.args[0];
    if (!position?.selector) return;
    state.scrollPositions.set(position.selector, position);
    updateAnnotationPositions();
    const linked = state.annotations.filter(annotation => {
      const contexts = annotation.scrollContexts?.length ? annotation.scrollContexts : annotation.scrollContext ? [annotation.scrollContext] : [];
      return contexts.some(context => context.selector === position.selector);
    }).length;
    if (linked) logDiagnostic(`annotation-scroll selector=${position.selector} top=${position.top} left=${position.left} linked=${linked}`);
    return;
  }
  if (event.channel === 'inspector-error') logDiagnostic(`inspector-error ${JSON.stringify(event.args[0])}`);
  if (event.channel === 'wheel-forwarded') logDiagnostic(`wheel-forwarded ${JSON.stringify(event.args[0])}`);
  if (event.channel === 'wheel-direct') logDiagnostic(`wheel-direct ${JSON.stringify(event.args[0])}`);
});

function addChange() {
  const description = intent.value.trim();
  if (!state.target) { modeHelp.textContent = '请先在原型上选择一个元素或区域。'; return; }
  if (!description && operation.value !== 'delete') {
    modeHelp.textContent = '请先输入你的修改需求，再加入清单。';
    intent.focus();
    return;
  }
  const type = operation.value;
  state.changes.push({
    id: crypto.randomUUID(),
    type,
    target: state.target,
    intent: description || '删除或隐藏该元素，保持其他区域不变。',
    createdAt: new Date().toISOString()
  });
  intent.value = '';
  resetTarget();
  renderChanges();
  modeHelp.textContent = '已加入清单。继续标注，或生成精简 Prompt。';
}

function renderChanges() {
  $('changeCount').textContent = state.changes.length;
  $('clearChanges').disabled = !state.changes.length;
  const list = $('changeList');
  if (!state.changes.length) { list.innerHTML = '<p class="list-empty">还没有修改需求。</p>'; return; }
  list.innerHTML = state.changes.map((change, index) => `
    <article class="change-card"><b>${index + 1}. ${operationLabels[change.type]} · ${escapeHtml(short(change.target.text || change.target.selector || '标注区域', 34))}</b>
    <p>${escapeHtml(change.intent)}</p><button data-delete-change="${change.id}" title="删除这条需求">×</button></article>`).join('');
}

$('changeList').addEventListener('click', event => {
  const id = event.target.dataset.deleteChange;
  if (!id) return;
  state.changes = state.changes.filter(change => change.id !== id);
  renderChanges();
});

$('clearChanges').addEventListener('click', () => {
  if (!state.changes.length) return;
  state.changes = [];
  renderChanges();
  modeHelp.textContent = '已清空修改清单。';
});

function targetLine(target, expanded = false) {
  const selector = target.selector || target.parentSelector || '圈选区域';
  const current = target.text ? `当前=${JSON.stringify(short(target.text, 90))}` : '';
  const page = target.pageLocation;
  const semanticLocation = page ? [
    page.pageName && `页面实例=${JSON.stringify(page.pageName)}${page.pageId ? `(${page.pageId})` : ''}`,
    page.pageState && `状态=${page.pageState}`,
    page.componentName && `组件=${JSON.stringify(page.componentName)}${page.componentId ? `(${page.componentId})` : ''}`,
    page.elementName && `目标=${JSON.stringify(page.elementName)}${page.elementId ? `(${page.elementId})` : ''}`
  ].filter(Boolean).join('；') : '';
  const pageLocation = page ? [
    !semanticLocation && page.pageTitle && `页面=${JSON.stringify(page.pageTitle)}`,
    !semanticLocation && page.area && `区域=${JSON.stringify(short(page.area, 75))}`,
    !semanticLocation && page.nearbyText && `邻近=${JSON.stringify(short(page.nearbyText, 75))}`,
    !semanticLocation && page.siblingIndex && `同级第${page.siblingIndex}项`
  ].filter(Boolean).join('；') : '';
  const trail = target.stateContext?.interactionTrail?.length
    ? `到达路径=${target.stateContext.interactionTrail.map(item => short(item.action, 32)).join(' → ')}`
    : '';
  const urlState = !semanticLocation && target.stateContext?.hash ? `状态=${target.stateContext.hash}` : '';
  const location = target.annotation?.type === 'insert' ? `位置=${Math.round(target.annotation.x)},${Math.round(target.annotation.y)}` : '';
  const context = expanded && target.snippet ? `\n局部HTML=${target.snippet}` : '';
  return [semanticLocation, trail, urlState, pageLocation, `DOM=${selector}`, current, location].filter(Boolean).join('；') + context;
}

function promptFor(expanded = false) {
  if (!state.changes.length) return '';
  const file = state.project?.fileName || '当前 HTML 文件';
  const intro = `修改 \`${file}\`。全局：未标注区域不变；沿用现有设计语言；兼容桌面端和移动端；不引入新框架。`;
  const lines = [intro, ''];
  state.changes.forEach((change, index) => {
    const code = { modify: 'M', insert: 'I', delete: 'D', optimize: 'O' }[change.type];
    lines.push(`[${code}${index + 1}] ${targetLine(change.target, expanded)}`);
    lines.push(`需求=${change.intent}`);
    if (change.type === 'insert') lines.push('说明=在该元素附近选择合适的父容器与插入位置；样式自动沿用页面体系。');
    if (change.type === 'delete') lines.push('说明=只删除或隐藏该目标，不影响相邻功能。');
    lines.push('');
  });
  lines.push('自行决定必要的 HTML/CSS/JS 实现；完成后简述修改过的文件与内容。');
  return lines.join('\n');
}

function showPrompt() {
  if (!state.changes.length) { modeHelp.textContent = '先加入至少一条修改需求，才能生成 Prompt。'; return; }
  const prompt = promptFor(false);
  $('promptOutput').value = prompt;
  $('tokenEstimate').textContent = `约 ${Math.ceil(prompt.length / 2.2)} Tokens`;
  $('promptDialog').showModal();
}

async function copy(value, button) {
  await navigator.clipboard.writeText(value);
  const original = button.textContent;
  button.textContent = '已复制';
  setTimeout(() => { button.textContent = original; }, 1200);
}

async function showDiagnostics() {
  resizePreview();
  const stageBounds = stage.getBoundingClientRect();
  const data = {
    stage: { width: Math.round(stageBounds.width), height: Math.round(stageBounds.height) },
    webview: {
      clientWidth: view.clientWidth,
      clientHeight: view.clientHeight,
      cssWidth: view.style.width,
      cssHeight: view.style.height,
      attrWidth: view.getAttribute('width'),
      attrHeight: view.getAttribute('height')
    }
  };
  data.annotations = state.annotations.map(annotation => ({
    id: annotation.id,
    type: annotation.type,
    scrollContexts: annotation.scrollContexts || (annotation.scrollContext ? [annotation.scrollContext] : []),
    currentScroll: (annotation.scrollContexts || (annotation.scrollContext ? [annotation.scrollContext] : [])).map(context => state.scrollPositions.get(context.selector) || null)
  }));
  try {
    data.prototype = await view.executeJavaScript(`({
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      body: { width: document.body?.scrollWidth, height: document.body?.scrollHeight, background: getComputedStyle(document.body).backgroundColor }
    })`);
  } catch (error) { data.prototypeError = error.message; }
  logDiagnostic(`diagnostic-snapshot ${JSON.stringify(data)}`);
  $('diagnosticOutput').textContent = `${JSON.stringify(data, null, 2)}\n\n最近日志：\n${(await window.lemon.readDiagnostic()).slice(-3000)}`;
  $('diagnosticDialog').showModal();
}

async function saveSession() {
  const saved = await window.lemon.saveSession({ version: 1, project: state.project, changes: state.changes, annotations: state.annotations });
  if (saved) modeHelp.textContent = `会话已保存：${saved.split('/').pop()}`;
}

async function loadSession() {
  const session = await window.lemon.loadSession();
  if (!session) return;
  state.changes = session.changes || [];
  state.annotations = session.annotations || [];
  renderChanges();
  if (session.project?.fileUrl) {
    state.project = session.project;
    $('fileInfo').textContent = state.project.filePath;
    $('refreshPrototype').disabled = false;
    $('emptyState').classList.add('hidden'); stage.classList.remove('hidden');
    const preloadUrl = await window.lemon.getWebviewPreload();
    view.setAttribute('preload', preloadUrl); view.src = state.project.fileUrl;
  }
  modeHelp.textContent = '已恢复标注会话。';
}

document.querySelectorAll('.tool').forEach(button => button.addEventListener('click', () => setMode(button.dataset.tool)));
document.querySelectorAll('.viewport').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('.viewport').forEach(item => item.classList.toggle('active', item === button));
  stage.classList.toggle('mobile', button.dataset.viewport === 'mobile');
}));
$('openProject').addEventListener('click', openProject);
$('openProjectEmpty').addEventListener('click', openProject);
$('refreshPrototype').addEventListener('click', refreshPrototype);
$('addChange').addEventListener('click', addChange);
$('generatePrompt').addEventListener('click', showPrompt);
$('deleteSelectedAnnotation').addEventListener('click', () => {
  if (!state.selectedAnnotationId) return;
  state.annotations = state.annotations.filter(annotation => annotation.id !== state.selectedAnnotationId);
  clearSelectedAnnotation();
  renderAnnotations();
  modeHelp.textContent = '已删除所选笔迹。';
});
$('clearAnnotations').addEventListener('click', () => { state.annotations = []; clearSelectedAnnotation(); renderAnnotations(); modeHelp.textContent = '已清除当前页面上的全部笔迹。'; });
$('saveSession').addEventListener('click', saveSession);
$('loadSession').addEventListener('click', loadSession);
$('closeDialog').addEventListener('click', () => $('promptDialog').close());
$('showDiagnostics').addEventListener('click', showDiagnostics);
$('closeDiagnostic').addEventListener('click', () => $('diagnosticDialog').close());
$('copyDiagnostic').addEventListener('click', event => copy($('diagnosticOutput').textContent, event.currentTarget));
$('copyPrompt').addEventListener('click', event => copy(promptFor(false), event.currentTarget));
$('copyEnhanced').addEventListener('click', event => copy(promptFor(true), event.currentTarget));
document.addEventListener('keydown', event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') addChange(); });
