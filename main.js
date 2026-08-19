const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');

let mainWindow;
const diagnosticLogPath = path.join(app.getPath('temp'), 'mpatch-debug.log');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    title: 'MPatch · 原型圈改工具',
    backgroundColor: '#f7f7f2',
    icon: path.join(__dirname, 'assets', 'mpatch-icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      sandbox: false
    }
  });
  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    fs.appendFile(diagnosticLogPath, `[renderer:${level}] ${sourceId}:${line} ${message}\n`).catch(() => {});
  });
}

app.whenReady().then(() => {
  fs.writeFile(diagnosticLogPath, `[${new Date().toISOString()}] MPatch started\n`).catch(() => {});
  ipcMain.handle('project:open-html', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择要标注的 HTML 原型',
      properties: ['openFile'],
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const filePath = result.filePaths[0];
    return { filePath, fileName: path.basename(filePath), fileUrl: pathToFileURL(filePath).href };
  });

  ipcMain.handle('project:save-session', async (_event, payload) => {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '保存 MPatch 会话',
      defaultPath: 'untitled.mpatch.json',
      filters: [{ name: 'MPatch 会话', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, JSON.stringify(payload, null, 2), 'utf8');
    return result.filePath;
  });

  ipcMain.handle('project:load-session', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '打开 MPatch 会话',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePaths[0]) return null;
    return JSON.parse(await fs.readFile(result.filePaths[0], 'utf8'));
  });

  ipcMain.handle('app:webview-preload', () => pathToFileURL(path.join(__dirname, 'webview-preload.js')).href);
  ipcMain.handle('diagnostic:log', async (_event, message) => {
    await fs.appendFile(diagnosticLogPath, `[${new Date().toISOString()}] ${String(message)}\n`);
  });
  ipcMain.handle('diagnostic:read', async () => {
    try { return await fs.readFile(diagnosticLogPath, 'utf8'); } catch { return ''; }
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
