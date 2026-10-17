// Мост с 3DPainter: проект `.3dpaint` ↔ готовая модель студии.
//
// Открыть: страница сводит слои и присылает GLB с покраской (src/painter.js);
// здесь он ложится в out/<имя>/<имя>.glb, рядом — копия проекта
// <имя>.3dpaint, атласы лица и painter.json (откуда проект, куда сохраняли).
// Тот же проект, открытый снова после докраски, попадает в ту же модель:
// покраска обновляется, а скелет и движения (anim/<имя>/) остаются.
//
// Сохранить: страница присылает модель со скелетом и движениями, здесь она
// заменяет model.glb в копии проекта. Остальное в проекте — слои, лицо,
// варианты, поза — переносится байт в байт, без распаковки.

import fs from 'node:fs';
import path from 'node:path';
import { ws } from './store.mjs';
import { UserError } from './errors.mjs';
import * as anim from './anim.mjs';

const okName = (n) => /^[\w.-]+$/.test(n) && !n.startsWith('.');
const outDir = (name) => path.join(ws(), 'out', name);
const infoFile = (name) => path.join(outDir(name), 'painter.json');
const projFile = (name) => path.join(outDir(name), `${name}.3dpaint`);

function readJson(abs, def = null) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return def; }
}
function writeAtomic(abs, data) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs + '.tmp', data);
  fs.renameSync(abs + '.tmp', abs);
}

// ── zip: только то, что нужно проекту 3DPainter ─────────────────────────────
// Записи читаем по центральному каталогу; данные чужих записей копируем как
// есть (сжатыми), новую кладём без сжатия — GLB и так плотный.

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new UserError('paintBad');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new UserError('paintBad');
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    out.push({
      name: buf.subarray(p + 46, p + 46 + nameLen).toString('utf8'),
      central: buf.subarray(p, p + 46 + nameLen + extraLen + commentLen),
      local: buf.subarray(local, local + 30 + lNameLen + lExtraLen + buf.readUInt32LE(p + 20)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Новый zip: записи как были, `name` — новыми байтами (или дописан).
function zipReplace(buf, name, data) {
  const entries = zipEntries(buf).filter((e) => e.name !== name);
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(data);
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);           // имя в UTF-8
  local.writeUInt16LE(0, 8);                // без сжатия
  local.writeUInt32LE(0x00210000, 10);      // время и дата — 1980-01-01
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);
  const central = Buffer.alloc(46 + nameBuf.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  local.copy(central, 8, 6, 30);            // флаги, метод, время, CRC, размеры, длина имени
  nameBuf.copy(central, 46);
  // model.glb — первым, как у самого 3DPainter.
  const all = [{ name, local: Buffer.concat([local, data]), central }, ...entries];
  const parts = [];
  const dir = [];
  let off = 0;
  for (const e of all) {
    const c = Buffer.from(e.central);
    c.writeUInt32LE(off, 42);
    dir.push(c);
    parts.push(e.local);
    off += e.local.length;
  }
  const dirBuf = Buffer.concat(dir);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(all.length, 8);
  end.writeUInt16LE(all.length, 10);
  end.writeUInt32LE(dirBuf.length, 12);
  end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, dirBuf, end]);
}

// ── открыть ─────────────────────────────────────────────────────────────────

// Имя модели: тот же проект (по пути, откуда открывали или куда сохраняли) —
// та же модель; новый — по имени файла, без столкновений с чужими моделями.
function pickName(file, source) {
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(ws(), 'out'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* нет out */ }
  if (source) {
    const same = dirs.find((d) => (readJson(infoFile(d))?.paths || []).includes(source));
    if (same) return same;
  }
  const stem = String(file || 'model').replace(/\.3dpaint$/i, '').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 60) || 'model';
  if (!dirs.includes(stem)) return stem;
  // Та же папка от проекта с тем же именем (путь не известен — браузер) — она.
  if (!source && readJson(infoFile(stem))) return stem;
  for (let n = 2; ; n++) if (!dirs.includes(`${stem}_${n}`)) return `${stem}_${n}`;
}

/** Имя модели для проекта — странице, чтобы назвать атласы лица так же. */
export function nameFor(file, source) {
  const f = path.basename(String(file || ''));
  if (!/\.3dpaint$/i.test(f)) throw new UserError('paintBad');
  return pickName(f, typeof source === 'string' && path.isAbsolute(source) ? source : null);
}

/**
 * body: { file, source?, paint? (base64, если пути нет), glb (base64),
 *         extras: [{name, data}] — атласы и описание лица }
 */
export async function importPaint(body = {}) {
  const file = path.basename(String(body.file || ''));
  if (!/\.3dpaint$/i.test(file) || typeof body.glb !== 'string') throw new UserError('paintBad');
  const source = typeof body.source === 'string' && path.isAbsolute(body.source) && fs.existsSync(body.source) ? body.source : null;
  if (!source && typeof body.paint !== 'string') throw new UserError('paintBad');
  const name = pickName(file, source);
  const dir = outDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const paint = source ? fs.readFileSync(source) : Buffer.from(body.paint, 'base64');
  zipEntries(paint);                                   // это вообще zip?
  writeAtomic(projFile(name), paint);
  // Прежние атласы лица — прочь: лицо могли убрать или переименовать части.
  for (const f of fs.readdirSync(dir)) if (/_face(_\w+\.png|\.json)$/.test(f)) fs.rmSync(path.join(dir, f), { force: true });
  for (const x of Array.isArray(body.extras) ? body.extras : []) {
    const n = path.basename(String(x?.name || ''));
    if (/^[\w.-]+_face(_\w+\.png|\.json)$/.test(n) && typeof x.data === 'string') writeAtomic(path.join(dir, n), Buffer.from(x.data, 'base64'));
  }
  writeAtomic(path.join(dir, `${name}.glb`), Buffer.from(body.glb, 'base64'));
  const was = readJson(infoFile(name), {});
  const paths = [...new Set([source, ...(was.paths || [])].filter(Boolean))].slice(0, 10);
  writeAtomic(infoFile(name), JSON.stringify({ file, source: source || was.source || null, paths, opened: Date.now(), saved: was.saved || null }, null, 1));
  // Скелет уже был — пересобрать основу и привязку с новой покраской; не было,
  // а в проекте он есть (сохраняли из другой студии или под другим именем) —
  // восстановить скелет и движения из файла.
  const rebound = await anim.repaint(name);
  const restored = !rebound && body.restore ? await anim.restore(name, body.restore) : false;
  return { name, rebound, restored, clips: restored ? (body.restore.clips || []).length : 0 };
}

// ── сохранить ───────────────────────────────────────────────────────────────

export function info(name) {
  if (!okName(name) || !fs.existsSync(projFile(name))) throw new UserError('paintNone');
  const i = readJson(infoFile(name), {});
  return { name, project: `out/${name}/${name}.3dpaint`, source: i.source || null, saved: i.saved || null, file: i.file || `${name}.3dpaint` };
}

/** body: { glb (base64) } — модель со скелетом и движениями вместо model.glb. */
export function savePaint(name, body = {}) {
  info(name);
  if (typeof body.glb !== 'string') throw new UserError('paintBad');
  const glb = Buffer.from(body.glb, 'base64');
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new UserError('paintBad');   // 'glTF'
  writeAtomic(projFile(name), zipReplace(fs.readFileSync(projFile(name)), 'model.glb', glb));
  return info(name);
}

/** Куда сохранили копию проекта (путь знает только окно Electron). */
export function noteSaved(name, where) {
  info(name);
  if (typeof where !== 'string' || !path.isAbsolute(where)) throw new UserError('paintBad');
  const i = readJson(infoFile(name), {});
  i.saved = where;
  i.paths = [...new Set([where, ...(i.paths || [])])].slice(0, 10);
  writeAtomic(infoFile(name), JSON.stringify(i, null, 1));
  return info(name);
}

export const _test = { zipEntries, zipReplace, crc32 };
