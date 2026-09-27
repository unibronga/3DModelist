// Настройки 3DModelist: рабочая папка, подключение к Claude, ключ fal.ai,
// Blender. Хранятся в папке данных приложения (та же, что у Electron:
// ~/Library/Application Support/3DModelist на macOS), файл закрыт от других
// пользователей (0600). Ключи наружу страницы уходят только замаскированными.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function appHome() {
  if (process.env.MODELIST_HOME) return process.env.MODELIST_HOME;
  const h = os.homedir();
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', '3DModelist');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(h, 'AppData', 'Roaming'), '3DModelist');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(h, '.config'), '3DModelist');
}

const FILE = () => path.join(appHome(), 'settings.json');

export const UI_LANGS = ['en', 'de', 'fr', 'nl', 'es', 'uk', 'ru'];

// ── поиск программ ─────────────────────────────────────────────────────────
const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };

// PATH как у терминала: приложение из Finder получает урезанный PATH.
export function fullPath() {
  const h = os.homedir();
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', path.join(h, '.local', 'bin'),
    path.join(h, '.claude', 'local'), path.join(h, '.npm-global', 'bin'), '/usr/bin', '/bin'];
  const cur = (process.env.PATH || '').split(path.delimiter);
  return [...new Set([...cur, ...extra])].filter(Boolean).join(path.delimiter);
}

export function which(name) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of fullPath().split(path.delimiter)) {
    for (const e of exts) if (exists(path.join(dir, name + e))) return path.join(dir, name + e);
  }
  return null;
}

function findBlender() {
  const cands = [];
  if (process.platform === 'darwin') {
    cands.push('/Applications/Blender.app/Contents/MacOS/Blender',
      path.join(os.homedir(), 'Applications', 'Blender.app', 'Contents', 'MacOS', 'Blender'));
  } else if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    try {
      const base = path.join(pf, 'Blender Foundation');
      for (const d of fs.readdirSync(base).sort().reverse()) cands.push(path.join(base, d, 'blender.exe'));
    } catch { /* нет */ }
  }
  cands.push(which('blender'));
  return cands.find(exists) || '';
}

// ── значения по умолчанию ──────────────────────────────────────────────────
function defaults() {
  return {
    workspace: '',                       // пусто — ещё не выбрана
    // Интерфейс: язык (пусто — по системе), тема (light | dark | system), масштаб.
    // Агент отвечает на том языке, на котором ему пишут; язык интерфейса — ему подсказка.
    ui: { lang: '', theme: 'system', scale: 1 },
    onboarded: false,                    // первый запуск пройден (окно приветствия больше не показывать)
    claude: {
      mode: 'subscription',              // subscription | api
      bin: which('claude') || '',
      configDir: '',                     // свой профиль Claude Code (CLAUDE_CONFIG_DIR), пусто — обычный
      apiKey: '',
    },
    fal: { key: '' },
    blender: {
      bin: findBlender(),
      port: 9876,
    },
  };
}

function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
  }
  return out;
}

let cache = null;

export function load() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { /* первый запуск */ }
  cache = merge(defaults(), saved);
  // Путь нашёлся после установки программы — подхватить, не заставляя вписывать руками.
  if (!exists(cache.claude.bin)) cache.claude.bin = which('claude') || cache.claude.bin;
  if (!exists(cache.blender.bin)) cache.blender.bin = findBlender() || cache.blender.bin;
  return cache;
}

function save(s) {
  fs.mkdirSync(appHome(), { recursive: true });
  const tmp = FILE() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
  try { fs.chmodSync(FILE(), 0o600); } catch { /* Windows */ }
  cache = s;
  return s;
}

const mask = (k) => (k ? { set: true, tail: '…' + k.slice(-4) } : { set: false });

// Что видит страница: всё, кроме самих ключей.
export function publicView() {
  const s = load();
  return {
    workspace: s.workspace,
    ui: s.ui,
    onboarded: !!s.onboarded,
    claude: { mode: s.claude.mode, bin: s.claude.bin, configDir: s.claude.configDir, apiKey: mask(s.claude.apiKey) },
    fal: { key: mask(s.fal.key) },
    blender: { bin: s.blender.bin, port: s.blender.port },
    home: appHome(),
  };
}

// Правка из окна настроек. Ключ: строка — заменить, null — стереть,
// отсутствие поля — оставить как было.
export function update(p = {}) {
  const s = structuredClone(load());
  if (typeof p.workspace === 'string') s.workspace = p.workspace.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (p.ui) {
    if (UI_LANGS.includes(p.ui.lang)) s.ui.lang = p.ui.lang;
    if (['light', 'dark', 'system'].includes(p.ui.theme)) s.ui.theme = p.ui.theme;
    const k = Number(p.ui.scale);
    if (k >= 0.8 && k <= 1.4) s.ui.scale = Math.round(k * 100) / 100;
  }
  if (typeof p.onboarded === 'boolean') s.onboarded = p.onboarded;
  if (p.claude) {
    const c = p.claude;
    if (c.mode === 'subscription' || c.mode === 'api') s.claude.mode = c.mode;
    if (typeof c.bin === 'string') s.claude.bin = c.bin.trim();
    if (typeof c.configDir === 'string') s.claude.configDir = c.configDir.trim().replace(/^~(?=$|\/)/, os.homedir());
    if (c.apiKey === null) s.claude.apiKey = '';
    else if (typeof c.apiKey === 'string' && c.apiKey.trim()) s.claude.apiKey = c.apiKey.trim();
  }
  if (p.fal) {
    if (p.fal.key === null) s.fal.key = '';
    else if (typeof p.fal.key === 'string' && p.fal.key.trim()) s.fal.key = p.fal.key.trim();
  }
  if (p.blender) {
    if (typeof p.blender.bin === 'string') s.blender.bin = p.blender.bin.trim();
    const port = Number(p.blender.port);
    if (Number.isInteger(port) && port > 1023 && port < 65536) s.blender.port = port;
  }
  return save(s);
}

export const defaultWorkspace = () => path.join(os.homedir(), 'Documents', '3DModelist');
export { exists };
