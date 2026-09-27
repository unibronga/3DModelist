// Хранилище задач: <рабочая папка>/runs/studio/<id>/task.json + events.jsonl.
// Задача — один заказ: референс, путь (скрипт/генератор), выбор агентов, ход
// работы. Файлы модели живут в самой рабочей папке — refs/, out/, renders/,
// models/ — студия их не прячет, а показывает.

import fs from 'node:fs';
import path from 'node:path';
import { load as loadSettings } from './settings.mjs';

// Корень рабочей папки берётся из настроек при каждом обращении: сменили
// папку в настройках — студия сразу работает в новой.
export const ws = () => loadSettings().workspace;
export const tasksDir = () => path.join(ws(), 'runs', 'studio');
export const statusJson = () => path.join(ws(), 'runs', 'current', 'status.json');

// ── имя папки из названия ─────────────────────────────────────────────────
const TR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi',
  є: 'e', ґ: 'g',
};

export function slugify(text) {
  const s = [...String(text).toLowerCase()].map((c) => TR[c] ?? c).join('')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return s || 'model';
}

// Папка модели не должна наезжать на уже существующую: crate → crate_2.
export function freeSlug(base) {
  const root = ws();
  const taken = (s) => ['refs', 'out', 'models'].some((d) =>
    fs.existsSync(path.join(root, d, s)) || fs.existsSync(path.join(root, d, s + '.blend')))
    || listTasks().some((t) => t.slug === s);
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}_${i}`)) return `${base}_${i}`;
}

// ── задачи ─────────────────────────────────────────────────────────────────
const taskFile = (id) => path.join(tasksDir(), id, 'task.json');
const eventsFile = (id) => path.join(tasksDir(), id, 'events.jsonl');

export function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function loadTask(id) {
  if (!ws() || !/^[\w-]+$/.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(taskFile(id), 'utf8')); } catch { return null; }
}

export function saveTask(task) {
  fs.mkdirSync(path.join(tasksDir(), task.id), { recursive: true });
  task.updated_at = Date.now() / 1000;
  const tmp = taskFile(task.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
  fs.renameSync(tmp, taskFile(task.id));     // атомарно: страница читает во время записи
  return task;
}

export function patchTask(id, fn) {
  const t = loadTask(id);
  if (!t) return null;
  fn(t);
  return saveTask(t);
}

export function listTasks() {
  if (!ws()) return [];
  let ids = [];
  try { ids = fs.readdirSync(tasksDir()); } catch { /* пусто */ }
  return ids.map(loadTask).filter(Boolean)
    .sort((a, b) => b.created_at - a.created_at);
}

// ── лента задачи: то, что видит человек ────────────────────────────────────
// kind: text (агент говорит), tool (агент делает), user (человек), system
// (студия), error, result (агент закончил ход), gen (генератор).
export function addEvent(id, ev) {
  const row = { t: Date.now() / 1000, ...ev };
  fs.mkdirSync(path.dirname(eventsFile(id)), { recursive: true });
  fs.appendFileSync(eventsFile(id), JSON.stringify(row) + '\n');
  return row;
}

export function readEvents(id, after = 0) {
  let lines = [];
  try { lines = fs.readFileSync(eventsFile(id), 'utf8').split('\n').filter(Boolean); } catch { /* нет */ }
  return { total: lines.length, events: lines.slice(after).map((l) => JSON.parse(l)) };
}

// ── табло этапов: runs/current/status.json пишет tools/pipe ────────────────
export function pipeStatus() {
  try { return JSON.parse(fs.readFileSync(statusJson(), 'utf8')); } catch { return null; }
}

// Этапы — те же, что в kit/tools/dashboard/pipeline.py (номер 4 снят).
export const STAGES = [
  { n: 0, title: 'Референс и спека', short: 'Спека', gate: true },
  { n: 1, title: 'Форма', short: 'Форма' },
  { n: 2, title: 'Подача', short: 'Подача' },
  { n: 3, title: 'Приёмка', short: 'Приёмка' },
  { n: 5, title: 'Выдача', short: 'Выдача' },
];
