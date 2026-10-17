// Мостики страницы к окну: выбор папки, вход в Claude через Терминал, показ папки в Finder,
// «Правка» из меню окна.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('modelist', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  claudeLogin: () => ipcRenderer.invoke('claude-login'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  // 3DPainter: путь открытого файла, сохранить копию проекта системным окном,
  // открыть проект в 3DPainter.
  pathOf: (file) => { try { return webUtils.getPathForFile(file) || null; } catch { return null; } },
  savePaint: (rel, defaultPath) => ipcRenderer.invoke('save-paint', rel, defaultPath),
  openInPainter: (abs) => ipcRenderer.invoke('open-in-painter', abs),
  // «Правка» из меню окна: страница решает, отменять правку модели или текста.
  onEdit: (cb) => ipcRenderer.on('edit', (_e, a) => cb(a)),
  nativeEdit: (a) => ipcRenderer.send('edit-native', a),
});
