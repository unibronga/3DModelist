// Рабочая папка: где лежат референсы, скрипты, модели — и набор пайплайна
// (kit/), с которым работает агент: инструкция CLAUDE.md, скилы этапов,
// библиотека хелперов Blender, мост и сервер Blender.
//
// «Подготовить» только ДОКЛАДЫВАЕТ недостающее и никогда не перезаписывает:
// в папке, где уже шла работа, свои правила и скилы главнее набора.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './errors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// В собранном приложении kit распакован рядом с app.asar — там его видят python и bash.
export const KIT = path.resolve(HERE, '..', 'kit').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);

const FOLDERS = ['refs', 'scenes', 'models', 'renders', 'out', 'runs'];
const EXEC = ['tools/bl', 'tools/pipe', 'tools/blender_bridge.py'];
// Что должно быть, чтобы агент мог работать.
const REQUIRED = ['CLAUDE.md', 'lib/artist.py', 'tools/bl', 'tools/pipe', 'tools/blender_bridge.py',
  'tools/dashboard/pipeline.py', 'blender/modelist_server.py'];

function kitFiles(dir = KIT, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.DS_Store' || e.name === '__pycache__') continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...kitFiles(path.join(dir, e.name), r));
    else out.push(r);
  }
  return out;
}

export function status(root) {
  if (!root) return { set: false };
  const st = { set: true, path: root, exists: fs.existsSync(root) };
  if (!st.exists) return st;
  try { fs.accessSync(root, fs.constants.W_OK); st.writable = true; } catch { st.writable = false; }
  st.missing = REQUIRED.filter((f) => !fs.existsSync(path.join(root, f)));
  let skills = [];
  try { skills = fs.readdirSync(path.join(root, '.claude', 'skills')).filter((d) => !d.startsWith('.')); } catch { /* нет */ }
  st.skills = skills.length;
  st.ready = st.writable && st.missing.length === 0 && skills.length > 0;
  return st;
}

export function prepare(root) {
  if (!root) throw new UserError('noWorkspace');
  fs.mkdirSync(root, { recursive: true });
  for (const d of FOLDERS) fs.mkdirSync(path.join(root, d), { recursive: true });
  const added = [];
  for (const rel of kitFiles()) {
    const dst = path.join(root, rel);
    if (fs.existsSync(dst)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(KIT, rel), dst);
    added.push(rel);
  }
  for (const rel of EXEC) {
    try { fs.chmodSync(path.join(root, rel), 0o755); } catch { /* нет файла или Windows */ }
  }
  return { added, status: status(root) };
}
