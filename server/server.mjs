// 3DModelist — локальный сервер без зависимостей (только node).
//
//   node server/server.mjs          → http://127.0.0.1:8770  (браузерный режим)
//   electron/main.cjs зовёт start() → то же внутри окна приложения
//
// Отдаёт собранную страницу (dist/), API задач и настроек, файлы рабочей папки
// (refs/, renders/, out/, models/) для просмотра. Слушает только 127.0.0.1.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ws, STAGES, slugify, freeSlug, newId, loadTask, saveTask, patchTask, listTasks,
  addEvent, readEvents, pipeStatus,
} from './store.mjs';
import { AGENT_MODELS, EFFORTS, runTurn, stopTurn, stopAll, busyTask, firstPrompt, testClaude } from './agent.mjs';
import { GENERATORS, genById, submit, watch, testFal, falKeySource } from './fal.mjs';
import { library, taskMedia, refsTree } from './library.mjs';
import * as settings from './settings.mjs';
import * as workspace from './workspace.mjs';
import * as blender from './blender.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, '..', 'dist');
const FILE_ROOTS = ['refs', 'renders', 'out', 'models'];
const VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'package.json'), 'utf8')).version; } catch { return '?'; }
})();

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.fbx': 'application/octet-stream', '.obj': 'text/plain',
  '.mtl': 'text/plain', '.md': 'text/plain; charset=utf-8', '.blend': 'application/octet-stream',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}

function sendFile(res, abs, download = false) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, { error: 'нет файла' });
    const headers = {
      'Content-Type': TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size, 'Cache-Control': 'no-store',
    };
    if (download) headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(abs))}"`;
    res.writeHead(200, headers);
    fs.createReadStream(abs).pipe(res);
  });
}

function readBody(req, limit = 60e6) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); }
    });
  });
}

// ── готовность: что уже настроено, чего не хватает ──────────────────────────
async function health() {
  const s = settings.load();
  const wsSt = workspace.status(s.workspace);
  return {
    version: VERSION,
    workspace: wsSt,
    claude: {
      mode: s.claude.mode,
      bin: settings.exists(s.claude.bin),
      key: s.claude.mode === 'api' ? !!s.claude.apiKey : null,
      ok: settings.exists(s.claude.bin) && (s.claude.mode !== 'api' || !!s.claude.apiKey),
    },
    python: !!settings.which('python3'),
    blender: { bin: settings.exists(s.blender.bin), ...(wsSt.exists ? await blender.ping() : { online: false }) },
    fal: { key: !!falKeySource(), source: falKeySource() },
    defaultWorkspace: settings.defaultWorkspace(),
  };
}

// ── задача: создание ────────────────────────────────────────────────────────
const IMG_RE = /^data:image\/(png|jpeg|jpg|webp);base64,/;

function createTask(body) {
  const ROOT = ws();
  const name = String(body.name || '').trim();
  if (!name) throw new Error('нужно название модели');
  const slug = freeSlug(slugify(body.slug || name));
  const id = newId();
  const refDir = path.join(ROOT, 'refs', slug);
  const refs = [];

  for (const r of body.uploads || []) {             // загруженные картинки
    const m = IMG_RE.exec(r.data || '');
    if (!m) continue;
    fs.mkdirSync(refDir, { recursive: true });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const base = slugify(path.parse(r.name || 'ref').name) || 'ref';
    let fname = `${base}.${ext}`;
    for (let i = 2; fs.existsSync(path.join(refDir, fname)); i++) fname = `${base}_${i}.${ext}`;
    fs.writeFileSync(path.join(refDir, fname), Buffer.from(r.data.slice(m[0].length), 'base64'));
    refs.push(path.relative(ROOT, path.join(refDir, fname)));
  }
  for (const p of body.refPaths || []) {             // уже лежащие в refs/
    const abs = path.resolve(ROOT, p);
    if (abs.startsWith(path.join(ROOT, 'refs') + path.sep) && fs.existsSync(abs)) refs.push(path.relative(ROOT, abs));
  }

  const a = body.agent || {};
  const task = saveTask({
    id, name, slug,
    brief: String(body.brief || '').trim(),
    route: body.route === 'generator' ? 'generator' : 'script',
    refs,
    agent: {
      model: AGENT_MODELS.some((x) => x.id === a.model && x.modeler) ? a.model : 'opus',
      effort: EFFORTS.includes(a.effort) ? a.effort : 'high',
      critic: a.critic === 'off' ? 'off' : (AGENT_MODELS.some((x) => x.id === a.critic) ? a.critic : 'opus'),
    },
    created_at: Date.now() / 1000,
    agent_state: 'idle',
    state: 'open',
    spent_usd: 0,
  });
  addEvent(id, { kind: 'system', text: `Задача создана. Папка модели: ${slug}. Референсов: ${refs.length}.` });
  return task;
}

function taskView(t) {
  const st = pipeStatus();
  return {
    ...t,
    running: busyTask() === t.id || starting === t.id,
    pipe: st && st.task === t.name ? st : null,
    media: taskMedia(t),
  };
}

// ── маршруты ────────────────────────────────────────────────────────────────
let starting = null;          // задача, для которой прямо сейчас поднимается Blender

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);   // ['api', ...]
  const m = req.method;

  if (parts[1] === 'meta' && m === 'GET') {
    return send(res, 200, {
      version: VERSION,
      stages: STAGES,
      agents: AGENT_MODELS,
      efforts: EFFORTS,
      generators: GENERATORS.map((g) => ({
        id: g.id, label: g.label, tag: g.tag, detail: g.detail,
        price: g.price({ texture: false }), priceTex: g.price({ texture: true }),
      })),
      busy: busyTask(),
    });
  }
  if (parts[1] === 'health' && m === 'GET') return send(res, 200, await health());

  // ── настройки ──
  if (parts[1] === 'settings') {
    if (m === 'GET') return send(res, 200, settings.publicView());
    if (m === 'PATCH') {
      if (busyTask()) return send(res, 409, { error: 'агент работает — настройки меняются после его хода' });
      settings.update(await readBody(req));
      return send(res, 200, settings.publicView());
    }
  }
  if (parts[1] === 'check' && m === 'POST') {
    if (parts[2] === 'claude') return send(res, 200, await testClaude());
    if (parts[2] === 'fal') return send(res, 200, await testFal());
  }
  if (parts[1] === 'workspace' && parts[2] === 'prepare' && m === 'POST') {
    try { return send(res, 200, workspace.prepare(ws())); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (parts[1] === 'blender') {
    if (!parts[2] && m === 'GET') return send(res, 200, ws() ? await blender.ping() : { online: false });
    if (parts[2] === 'version' && m === 'POST') {
      const b = await readBody(req);
      return send(res, 200, await blender.version(typeof b.bin === 'string' && b.bin ? b.bin : undefined));
    }
    if (parts[2] === 'launch' && m === 'POST') {
      const b = await readBody(req);
      try { return send(res, 200, await blender.launch({ background: !!b.background })); } catch (e) { return send(res, 400, { error: e.message }); }
    }
  }

  // Дальше — всё, что живёт в рабочей папке: без неё работать не с чем.
  if (!workspace.status(ws()).exists) {
    if (parts[1] === 'library' || parts[1] === 'refs' || (parts[1] === 'tasks' && !parts[2] && m === 'GET')) return send(res, 200, []);
    return send(res, 412, { error: 'сначала выбери рабочую папку в настройках' });
  }
  if (parts[1] === 'library' && m === 'GET') return send(res, 200, library());
  if (parts[1] === 'refs' && m === 'GET') return send(res, 200, refsTree());

  if (parts[1] === 'tasks') {
    const id = parts[2];
    if (!id && m === 'GET') {
      return send(res, 200, listTasks().map((t) => ({
        id: t.id, name: t.name, slug: t.slug, route: t.route, state: t.state,
        agent_state: busyTask() === t.id || starting === t.id ? 'running' : t.agent_state,
        created_at: t.created_at, spent_usd: t.spent_usd || 0, gen_state: t.gen?.state || null,
      })));
    }
    if (!id && m === 'POST') {
      const task = createTask(await readBody(req));
      return send(res, 200, taskView(task));
    }
    const task = loadTask(id);
    if (!task) return send(res, 404, { error: 'нет такой задачи' });
    const sub = parts[3];

    if (!sub && m === 'GET') return send(res, 200, taskView(task));
    if (!sub && m === 'PATCH') {
      const b = await readBody(req);
      const t = patchTask(id, (x) => {
        if (b.agent) {
          const a = b.agent;
          if (AGENT_MODELS.some((q) => q.id === a.model && q.modeler)) x.agent.model = a.model;
          if (EFFORTS.includes(a.effort)) x.agent.effort = a.effort;
          if (a.critic === 'off' || AGENT_MODELS.some((q) => q.id === a.critic)) x.agent.critic = a.critic;
        }
        if (b.state === 'done' || b.state === 'open') x.state = b.state;
        if (typeof b.brief === 'string') x.brief = b.brief;
      });
      return send(res, 200, taskView(t));
    }
    if (sub === 'events' && m === 'GET') {
      return send(res, 200, readEvents(id, Number(url.searchParams.get('after') || 0)));
    }
    if (sub === 'agent' && m === 'POST') {
      const b = await readBody(req);
      const text = String(b.message || '').trim();
      let prompt;
      if (!task.agent?.session_id) {
        prompt = firstPrompt(task) + (text ? `\n\nЕщё от человека: ${text}` : '');
      } else {
        if (!text) return send(res, 400, { error: 'пустое сообщение' });
        prompt = text;
      }
      if (busyTask() || starting) return send(res, 409, { error: 'агент уже занят другой задачей — Blender у нас один' });
      if (text) addEvent(id, { kind: 'user', text });
      else addEvent(id, { kind: 'system', text: 'Агент запущен.' });
      // Blender поднимаем сами и без окна — это может занять до ~10 с,
      // поэтому отвечаем сразу, а ход агента стартует следом.
      starting = id;
      patchTask(id, (t) => { t.agent_state = 'running'; });
      (async () => {
        try {
          const bl = await blender.ensure();
          if (bl.started) addEvent(id, { kind: 'system', text: 'Blender запущен без окна.' });
          if (!bl.online) addEvent(id, { kind: 'error', text: bl.error || 'Blender не запустился' });
          runTurn(id, prompt);
        } catch (e) {
          addEvent(id, { kind: 'error', text: e.message });
          patchTask(id, (t) => { t.agent_state = 'waiting'; });
        } finally {
          starting = null;
        }
      })();
      return send(res, 200, { ok: true });
    }
    if (sub === 'stop' && m === 'POST') return send(res, 200, { ok: stopTurn(id) });
    if (sub === 'generate' && m === 'POST') {
      const b = await readBody(req);
      if (!genById(b.model)) return send(res, 400, { error: 'неизвестный генератор' });
      try { await submit(id, b); } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 200, taskView(loadTask(id)));
    }
  }
  return send(res, 404, { error: 'нет такого адреса' });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);

    if (url.pathname.startsWith('/files/')) {
      const ROOT = ws();
      if (!ROOT) return send(res, 404, { error: 'нет рабочей папки' });
      const rel = decodeURIComponent(url.pathname.slice('/files/'.length));
      const abs = path.resolve(ROOT, rel);
      const top = path.relative(ROOT, abs).split(path.sep)[0];
      if (!FILE_ROOTS.includes(top) || !abs.startsWith(ROOT + path.sep)) return send(res, 403, { error: 'вне рабочей папки' });
      return sendFile(res, abs, url.searchParams.has('download'));
    }

    // собранная страница
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const abs = path.resolve(DIST, rel);
    if (!abs.startsWith(DIST)) return send(res, 403, { error: 'нельзя' });
    if (!fs.existsSync(path.join(DIST, 'index.html'))) return send(res, 200, 'Страница не собрана: npm run build', 'text/plain; charset=utf-8');
    return sendFile(res, fs.existsSync(abs) ? abs : path.join(DIST, 'index.html'));
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) });
  }
}

// После перезапуска: агент прошлого сервера не наш — снять «идёт»; генерации — дождаться.
function recover() {
  for (const t of listTasks()) {
    if (t.agent_state === 'running') {
      patchTask(t.id, (x) => { x.agent_state = 'waiting'; });
      addEvent(t.id, { kind: 'system', text: 'Студия перезапущена — ход агента прерван. Напиши агенту, чтобы продолжить.' });
    }
    if (['queued', 'running'].includes(t.gen?.state)) watch(t.id);
  }
}

// Поднять сервер. port 0 — любой свободный. Возвращает фактический порт.
export function start({ port = Number(process.env.MODELIST_PORT || 8770), fallback = false } = {}) {
  try { recover(); } catch (e) { console.error('[3DModelist] восстановление задач:', e.message); }
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      if (e.code === 'EADDRINUSE' && fallback) {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
      } else reject(e);
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Выход: остановить ход агента и Blender, которого студия поднимала без окна.
export function shutdown() {
  stopAll();
  blender.stopOurs();
}

// Запуск напрямую: node server/server.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start().then(({ port }) => {
    console.log(`3DModelist: http://127.0.0.1:${port}`);
  }, (e) => {
    console.error('3DModelist не поднялся:', e.message);
    process.exit(1);
  });
  const bye = () => { shutdown(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
