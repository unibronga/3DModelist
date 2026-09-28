// Мостики страницы к окну: выбор папки, вход в Claude через Терминал, показ папки в Finder,
// «Правка» из меню окна.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modelist', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  claudeLogin: () => ipcRenderer.invoke('claude-login'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  // «Правка» из меню окна: страница решает, отменять правку модели или текста.
  onEdit: (cb) => ipcRenderer.on('edit', (_e, a) => cb(a)),
  nativeEdit: (a) => ipcRenderer.send('edit-native', a),
});
