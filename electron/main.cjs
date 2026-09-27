/**
 * Оболочка 3DModelist для десктопа.
 *
 * Внутри приложения поднимается тот же сервер, что `npm run server` в
 * браузерном режиме (server/server.mjs), а окно показывает его страницу.
 * Страница остаётся обычной веб-страницей без доступа к Node; из окна ей
 * нужен ровно один мостик — выбрать папку системным диалогом (preload.cjs).
 */

const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Данные приложения: ~/Library/Application Support/3DModelist — там же их
// ищет сервер (server/settings.mjs), и браузерный режим делит с окном те же
// настройки. Для проверок можно подсунуть свою папку.
if (process.env.MODELIST_USER_DATA) app.setPath('userData', process.env.MODELIST_USER_DATA);
process.env.MODELIST_HOME = app.getPath('userData');

const DEV_URL = process.env.MODELIST_DEV_URL;
let win = null;
let server = null;
let url = null;

async function startServer() {
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'server.mjs')).href);
  // 8770 — как у браузерного режима; занят (браузерный сервер уже работает) — любой свободный.
  const r = await mod.start({ port: 8770, fallback: true });
  server = mod;
  url = `http://127.0.0.1:${r.port}/`;
  console.log('[3DModelist] сервер:', url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 680,
    title: '3DModelist',
    backgroundColor: '#eeeeec',        // цвет фона страницы: окно не мигает белым
    // Проверки (снимок, самопроверка) — в невидимом окне: не всплывают у человека на экране.
    show: !(process.env.MODELIST_SCREENSHOT || process.env.MODELIST_SELFTEST),
    paintWhenInitiallyHidden: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  // MODELIST_OPEN=out/<папка>/<файл>.glb — открыть модель сразу (для снимков и проверок).
  const open = process.env.MODELIST_OPEN ? '#model=' + encodeURIComponent(process.env.MODELIST_OPEN) : '';
  win.loadURL((DEV_URL || url) + open);

  win.webContents.on('did-finish-load', async () => {
    // Снимок окна для README: MODELIST_SCREENSHOT=docs/screenshot.png npm run desktop
    if (process.env.MODELIST_SCREENSHOT) {
      await new Promise((r) => setTimeout(r, Number(process.env.MODELIST_SCREENSHOT_DELAY || 4000)));
      // Действие перед снимком (раскрыть меню, открыть окно) — для проверок в самом приложении.
      if (process.env.MODELIST_SCREENSHOT_JS) {
        const res = await win.webContents.executeJavaScript(process.env.MODELIST_SCREENSHOT_JS).catch((e) => console.error('[3DModelist] действие:', e.message));
        if (res !== undefined) console.log('[3DModelist] действие →', JSON.stringify(res));
        await new Promise((r) => setTimeout(r, 800));
      }
      const img = await win.webContents.capturePage();
      require('node:fs').writeFileSync(process.env.MODELIST_SCREENSHOT, img.toPNG());
      console.log('[3DModelist] снимок:', process.env.MODELIST_SCREENSHOT);
      app.quit();
      return;
    }
    if (!process.env.MODELIST_SELFTEST) return;
    // Дымовая проверка сборки: страница поднялась, сервер отвечает, значок на месте.
    try {
      const report = await win.webContents.executeJavaScript(`
        new Promise((resolve) => setTimeout(async () => {
          const h = await fetch('/api/health').then((r) => r.json()).catch((e) => ({ error: e.message }));
          const icon = document.querySelector('.logo');
          resolve(JSON.stringify({
            версия: h.version,
            папка: h.workspace,
            claude: h.claude,
            blender: h.blender,
            fal: h.fal,
            python: h.python,
            значок: icon ? icon.complete && icon.naturalWidth > 0 : 'нет узла',
            панель: !!document.querySelector('#panel .panel-title'),
            мостик: typeof window.modelist?.pickFolder,
            вход: typeof window.modelist?.claudeLogin,
            приветствие: !!document.querySelector('.welcome'),
            язык: document.documentElement.lang,
            тема: document.documentElement.dataset.theme || 'system',
            масштаб: getComputedStyle(document.documentElement).getPropertyValue('--ui').trim(),
            ошибка: document.querySelector('.toast.err')?.textContent || null,
          }));
        }, 2500));
      `);
      console.log('[3DModelist] самопроверка:', report);
    } catch (e) {
      console.error('[3DModelist] самопроверка не прошла:', e.message);
    }
    app.quit();
  });
  win.webContents.on('did-fail-load', (_e, code, desc, u) => {
    console.error('[3DModelist] страница не загрузилась:', code, desc, u);
  });

  // Внешние ссылки (установка Claude Code, ключи fal) — в браузер.
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });
  // Скачивание GLB/.blend — системный диалог «Сохранить».
  win.webContents.session.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
  });
}

// Системное меню — стандартными ролями: их подписи macOS показывает на языке
// системы, а язык самой студии выбирается в её настройках.
function buildMenu() {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    // viewMenu не берём: его ⌘+/⌘− масштабирует страницу, а у студии свой
    // размер интерфейса на тех же клавишах — один смысл, один регулятор.
    { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'front' }] },
  ]));
}

// Вход в Claude по подписке делается в самой программе claude (/login).
// Открываем Терминал сразу с ней — человеку остаётся нажать Enter и войти.
ipcMain.handle('claude-login', async () => {
  const { load } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'settings.mjs')).href);
  const c = load().claude;
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;          // одинарные кавычки для shell
  const cmd = (c.configDir ? `CLAUDE_CONFIG_DIR=${q(c.configDir)} ` : '') + q(c.bin || 'claude');
  const osa = (v) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');       // кавычки для AppleScript
  require('node:child_process').execFile('osascript', [
    '-e', `tell application "Terminal" to do script "${osa(cmd)}"`,
    '-e', 'tell application "Terminal" to activate',
  ]);
  return true;
});

// Показать папку в Finder — только внутри рабочей папки.
ipcMain.handle('open-path', async (_e, p) => {
  const { load } = await import(pathToFileURL(path.join(__dirname, '..', 'server', 'settings.mjs')).href);
  const root = load().workspace;
  const abs = path.resolve(String(p || ''));
  if (!root || !(abs === root || abs.startsWith(root + path.sep))) return false;
  const err = await shell.openPath(abs);
  return !err;
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Рабочая папка 3DModelist',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

app.whenReady().then(async () => {
  buildMenu();
  try {
    await startServer();
  } catch (e) {
    dialog.showErrorBox('3DModelist не запустился', String(e.stack || e));
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Агент и фоновый Blender — отдельные процессы: закрыли приложение — гасим и их.
app.on('before-quit', () => { try { server?.shutdown(); } catch { /* нечего */ } });
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
