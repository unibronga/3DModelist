// Единственный мостик страницы к окну: системный диалог выбора папки.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('modelist', {
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
});
