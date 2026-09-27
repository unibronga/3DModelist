// Blender: проверка связи и запуск со своим сервером.
//
// Связь — тот же протокол, что у tools/blender_bridge.py (NUL-JSON по TCP),
// только из Node: для проверки не нужен ни python, ни мост.

import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { load, exists } from './settings.mjs';
import { ws } from './store.mjs';

export function execute(code, { port, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port: port || load().blender.port });
    const chunks = [];
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Blender не ответил')); }, timeout);
    sock.on('connect', () => sock.write(JSON.stringify({ type: 'execute', code, strict_json: false }) + '\0'));
    sock.on('data', (c) => {
      chunks.push(c);
      const buf = Buffer.concat(chunks);
      const end = buf.indexOf(0);
      if (end < 0) return;
      clearTimeout(timer);
      sock.end();
      try { resolve(JSON.parse(buf.subarray(0, end).toString('utf8'))); } catch (e) { reject(e); }
    });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

let cache = { t: 0, v: null };

export async function ping() {
  if (Date.now() - cache.t < 3000 && cache.v) return cache.v;
  let v;
  try {
    const r = await execute("import bpy\nresult = {'file': bpy.data.filepath, 'version': bpy.app.version_string, 'background': bpy.app.background}");
    // Ответил ошибкой — всё равно на связи: сокет жив, просто сервер не тот.
    if (r.status !== 'ok') { cache = { t: Date.now(), v: { online: true } }; return cache.v; }
    const root = ws();
    const f = r.result?.file || '';
    v = {
      online: true,
      version: r.result?.version,
      background: !!r.result?.background,
      file: f ? (root && f.startsWith(root + path.sep) ? path.relative(root, f) : f) : null,
    };
  } catch {
    v = { online: false };
  }
  cache = { t: Date.now(), v };
  return v;
}

// Запустить Blender с сервером 3DModelist. background — без окна.
export async function launch({ background = false } = {}) {
  const s = load();
  if ((await ping()).online) return { already: true };
  if (!exists(s.blender.bin)) throw new Error('не найден Blender — укажи путь в настройках');
  const script = path.join(ws(), 'blender', 'modelist_server.py');
  if (!exists(script)) throw new Error('в рабочей папке нет blender/modelist_server.py — нажми «Подготовить папку»');
  const args = background ? ['--background', '--python', script] : ['--python', script];
  const p = spawn(s.blender.bin, args, {
    cwd: ws(),
    env: { ...process.env, BLENDER_MCP_PORT: String(s.blender.port) },
    detached: true,
    stdio: 'ignore',
  });
  p.unref();
  cache = { t: 0, v: null };
  // Blender поднимается 3–10 с; ждём сервер, но не дольше 25 с.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 500));
    cache = { t: 0, v: null };
    if ((await ping()).online) return { started: true };
  }
  return { started: false, error: 'Blender запущен, но сервер не ответил за 25 с' };
}
