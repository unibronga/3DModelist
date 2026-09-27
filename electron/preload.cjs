// Мостики страницы к окну: выбор папки и вход в Claude через Терминал.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modelist', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  claudeLogin: () => ipcRenderer.invoke('claude-login'),
});
