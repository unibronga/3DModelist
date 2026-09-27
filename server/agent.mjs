// Агент-моделист: Claude Code без окна (`claude -p`) в рабочей папке.
//
// Подключение — из настроек:
//   • подписка — CLI, в который вошли командой `claude` → /login; платы за
//     агента нет, расходуется лимит подписки;
//   • ключ API — тот же CLI с ANTHROPIC_API_KEY; платится по токенам, сумма
//     каждого хода прибавляется к расходам задачи.
//
// Один ход агента = один процесс. Ход кончается сам (ворота спеки, вопрос,
// сдача) — человек отвечает в студии, и следующий ход идёт с `--resume` той
// же сессии: агент помнит всю задачу.

import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ws, addEvent, patchTask, loadTask, tasksDir } from './store.mjs';
import { load as settings, fullPath, exists } from './settings.mjs';

// Кого можно поставить моделистом и критиком. Алиасы CLI ведут на последние
// модели семейства. Haiku моделистом не ставится: режим разрешений auto у
// него не включается, и без окна он упирается в запреты.
export const AGENT_MODELS = [
  { id: 'opus', label: 'Opus', note: 'точнее всех, основной выбор', modeler: true },
  { id: 'sonnet', label: 'Sonnet', note: 'быстрее и экономнее', modeler: true },
  { id: 'haiku', label: 'Haiku', note: 'только критиком: быстрый взгляд', modeler: false },
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const running = new Map();          // id задачи → процесс
export const busyTask = () => [...running.keys()][0] || null;

// Окружение процесса claude — только из белого списка. Студию могут поднять
// из терминала или из сессии Claude Code, и тогда в окружении лежат чужие
// ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, CLAUDE_CODE_*: с ними агент молча
// ходит не через тот вход и не за тот счёт (поймано 27.09).
const ENV_KEEP = /^(HOME|USER|LOGNAME|SHELL|LANG|LC_\w+|TMPDIR|TEMP|TMP|TERM|__CF_USER_TEXT_ENCODING|SSH_AUTH_SOCK|XDG_\w+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|NODE_EXTRA_CA_CERTS|SystemRoot|SYSTEMROOT|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramFiles|ProgramData|COMSPEC|PATHEXT|WINDIR)$/;

function claudeEnv() {
  const s = settings();
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (ENV_KEEP.test(k)) env[k] = v;
  Object.assign(env, { PATH: fullPath(), PIPE_NO_OPEN: '1', BLENDER_MCP_PORT: String(s.blender.port) });
  if (s.claude.mode === 'api') {
    if (!s.claude.apiKey) throw new Error('не задан ключ Anthropic API — Настройки ▸ Claude');
    env.ANTHROPIC_API_KEY = s.claude.apiKey;
  }
  if (s.claude.configDir) env.CLAUDE_CONFIG_DIR = s.claude.configDir;
  return env;
}

function claudeBin() {
  const b = settings().claude.bin;
  if (!exists(b)) throw new Error('не найден Claude Code (claude) — Настройки ▸ Claude');
  return b;
}

function systemPrompt() {
  const s = settings();
  const lang = s.language === 'en' ? 'Reply to the user in English.' : 'Отвечай человеку по-русски.';
  return `Ты работаешь из 3DModelist — локального приложения человека, без терминала.
Рабочая папка (абсолютный путь, используй его в скриптах): ${ws()}
Человек видит: твои сообщения — лентой; этапы — с табло tools/pipe; кадры — все PNG,
которые ты пишешь в renders/<папка>/; модели — файлы в out/<папка>/.
Правила студии (сверх CLAUDE.md рабочей папки):
- Табло этапов уже открыто на эту задачу: tools/pipe task НЕ вызывать, только start/done/skip.
- Ворота спеки: покажи спеку коротко и ЗАКОНЧИ ход. Человек ответит в студии («ок» или правки).
  Так же заканчивай ход на любом вопросе к человеку — не жди в цикле.
- Платную генерацию (fal) сам не запускай: её запускает человек кнопкой в студии. Считаешь,
  что нужен генератор, — скажи об этом и закончи ход.
- Кадры по ходу сохраняй в renders/<папка>/ — студия показывает их сразу.
- Сообщения — коротко и понятно: что сделал, похоже ли на референс, что решать человеку.
- Artifact не использовать.
${lang}`;
}

function toolLabel(name, input = {}) {
  const rel = (p) => (p ? path.relative(ws(), p) || p : '');
  switch (name) {
    case 'Bash': return input.description || String(input.command || '').slice(0, 90);
    case 'Read': return 'смотрит ' + rel(input.file_path);
    case 'Write': return 'пишет ' + rel(input.file_path);
    case 'Edit': return 'правит ' + rel(input.file_path);
    case 'Skill': return 'скил ' + (input.skill || '');
    case 'Agent': case 'Task': return 'агент: ' + (input.description || input.subagent_type || '');
    case 'Glob': case 'Grep': return 'ищет ' + (input.pattern || '');
    default: return name.replace(/^mcp__[^_]+__/, '');
  }
}

// Открыть табло этапов на задачу (tools/pipe task).
function pipeTask(title) {
  try {
    execFileSync('python3', [path.join(ws(), 'tools', 'pipe'), 'task', title], {
      cwd: ws(), env: { ...process.env, PATH: fullPath(), PIPE_NO_OPEN: '1' }, timeout: 15000,
    });
  } catch (e) {
    return String(e.message || e);
  }
  return null;
}

export function firstPrompt(task) {
  const refs = (task.refs || []).map((r) => '  - ' + r).join('\n') || '  (референс не приложен — спросить человека)';
  const lines = [
    `Новая задача из студии: «${task.name}».`,
    task.brief ? `Что хочет человек: ${task.brief}` : '',
    `Папка модели: ${task.slug} (scenes/${task.slug}.py, models/${task.slug}.blend, out/${task.slug}/, renders/${task.slug}/).`,
    `Референс (прочитать глазами):\n${refs}`,
  ];
  if (task.route === 'generator') {
    const g = task.gen || {};
    lines.push(g.files?.length
      ? `Путь: генератор ${g.model}. Сырой результат уже скачан: ${g.files.join(', ')}. Человек его видел в студии. ` +
        'Дальше — по скилу fal-generate: импорт, масштаб в метры, посадка на пол, приёмка, выдача.'
      : 'Путь: генератор, но результата ещё нет — человек запустит его кнопкой. Пока — этап 0.');
  } else {
    lines.push('Путь: скрипт — конструкция по пайплайну CLAUDE.md.');
  }
  const c = task.agent?.critic;
  lines.push(c && c !== 'off'
    ? `Перед сдачей — агент blender-critic (модель ${c}).`
    : 'Критик перед сдачей не нужен — человек выключил.');
  lines.push('Начни с этапа 0 (скил blender-reference): спеку положи в refs/' + task.slug +
    '/spec.md, покажи её коротко и закончи ход.');
  return lines.filter(Boolean).join('\n');
}

// Запустить ход агента. message — текст человека (или первый промпт).
export function runTurn(id, message) {
  const task = loadTask(id);
  if (!task) throw new Error('нет такой задачи');
  if (busyTask()) throw new Error('агент уже занят другой задачей — Blender у нас один');
  const env = claudeEnv();
  const bin = claudeBin();

  const first = !task.agent?.session_id;
  if (first) {
    const err = pipeTask(task.name);
    if (err) addEvent(id, { kind: 'error', text: 'табло этапов не открылось: ' + err });
  }
  const a = task.agent || {};
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--model', a.model || 'opus',
    '--effort', a.effort || 'high',
    '--permission-mode', 'auto',
    '--append-system-prompt', systemPrompt(),
    '--allowedTools', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'Skill', 'Agent',
    'Bash(tools/bl:*)', 'Bash(tools/pipe:*)', 'Bash(python3 scripts/audit.py:*)',
    '--disallowedTools', 'Artifact', 'ArtifactComments', 'ArtifactData',
  ];
  if (!first) args.push('--resume', task.agent.session_id);

  const proc = spawn(bin, args, {
    cwd: ws(), env,
    detached: true,                         // своя группа: «Стоп» гасит и детей
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdin.end(message);                  // промпт через stdin: списки флагов его не съедят
  running.set(id, proc);
  patchTask(id, (t) => { t.agent_state = 'running'; t.turns = (t.turns || 0) + 1; t.billing = settings().claude.mode; });

  const rawLog = fs.createWriteStream(path.join(tasksDir(), id, 'agent.jsonl'), { flags: 'a' });
  let buf = '';
  let stderr = '';
  let gotResult = false;

  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      rawLog.write(line + '\n');
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      handle(id, m);
      if (m.type === 'result') gotResult = true;
    }
  });
  proc.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });
  proc.on('close', (code, signal) => {
    running.delete(id);
    rawLog.end();
    if (signal || (code && !gotResult)) {
      addEvent(id, {
        kind: signal ? 'system' : 'error',
        text: signal ? 'Агент остановлен.' : `Агент упал (код ${code}). ${stderr.trim().split('\n').slice(-3).join(' ')}`,
      });
    }
    patchTask(id, (t) => { t.agent_state = 'waiting'; });
  });
  proc.on('error', (e) => {
    running.delete(id);
    addEvent(id, { kind: 'error', text: 'Не запустился claude: ' + e.message });
    patchTask(id, (t) => { t.agent_state = 'waiting'; });
  });
}

function handle(id, m) {
  if (m.type === 'system' && m.subtype === 'init') {
    patchTask(id, (t) => {
      t.agent = { ...(t.agent || {}), session_id: m.session_id, model_full: m.model };
    });
    return;
  }
  if (m.type === 'assistant' && !m.parent_tool_use_id) {
    for (const b of m.message?.content || []) {
      if (b.type === 'text' && b.text.trim()) addEvent(id, { kind: 'text', text: b.text });
      if (b.type === 'tool_use') addEvent(id, { kind: 'tool', name: b.name, text: toolLabel(b.name, b.input) });
    }
    return;
  }
  if (m.type === 'system' && m.subtype === 'api_retry') {
    // 401/403 не пройдут повтором — claude переспрашивает минутами. Сразу стоп и объяснение.
    if (m.error_status === 401 || m.error_status === 403) {
      addEvent(id, { kind: 'error', text: authError(m.error_status) });
      stopTurn(id);
    } else if (m.attempt === 1) {
      addEvent(id, { kind: 'system', text: `Сервер Claude ответил ${m.error_status || m.error} — агент повторяет запрос.` });
    }
    return;
  }
  if (m.type === 'rate_limit_event') {
    const w = m.rate_limit_info?.unifiedWindows?.five_hour;
    if (w) patchTask(id, (t) => { t.limit5h = w.utilization; });
    return;
  }
  if (m.type === 'result') {
    patchTask(id, (t) => {
      const usd = m.total_cost_usd || 0;
      t.agent_api_usd = (t.agent_api_usd || 0) + usd;
      // По ключу API ход стоит денег — в расходы задачи; по подписке — нет.
      if (t.billing === 'api') t.spent_usd = (t.spent_usd || 0) + usd;
      t.agent_ms = (t.agent_ms || 0) + (m.duration_ms || 0);
    });
    addEvent(id, {
      kind: 'result',
      error: !!m.is_error,
      text: m.is_error ? (m.result || 'ход закончился ошибкой') : 'Агент закончил ход — ждёт тебя.',
    });
  }
}

function authError(status) {
  return settings().claude.mode === 'api'
    ? `Claude не принял ключ API (${status}). Проверь ключ: Настройки ▸ Claude.`
    : `Claude не принял вход по подписке (${status}). Открой Терминал, набери claude и в нём /login.`;
}

export function stopTurn(id) {
  const p = running.get(id);
  if (!p) return false;
  try { process.kill(-p.pid, 'SIGINT'); } catch { /* уже вышел */ }
  setTimeout(() => { try { process.kill(-p.pid, 'SIGTERM'); } catch { /* вышел */ } }, 4000);
  return true;
}

export function stopAll() {
  for (const id of running.keys()) stopTurn(id);
}

// Проверка подключения: короткий ход Haiku в пустой папке (без CLAUDE.md
// рабочей папки). По подписке бесплатно, по ключу — доли цента.
export function testClaude() {
  return new Promise((resolve) => {
    let env;
    let bin;
    try { env = claudeEnv(); bin = claudeBin(); } catch (e) { resolve({ ok: false, error: e.message }); return; }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'modelist-check-'));
    const p = spawn(bin, ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--max-turns', '1'],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin.end('Ответь одним словом: готов');
    const out = { ok: false };
    let buf = '';
    let err = '';
    const timer = setTimeout(() => { out.error = out.error || 'claude не ответил за 90 с'; p.kill('SIGTERM'); }, 90000);
    p.stdout.on('data', (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'system' && m.subtype === 'init') { out.model = m.model; out.version = m.claude_code_version; out.source = m.apiKeySource; }
        if (m.type === 'system' && m.subtype === 'api_retry' && (m.error_status === 401 || m.error_status === 403)) {
          out.error = authError(m.error_status);        // повтор не поможет — не ждать минутами
          p.kill('SIGTERM');
        }
        if (m.type === 'rate_limit_event') out.limit5h = m.rate_limit_info?.unifiedWindows?.five_hour?.utilization;
        if (m.type === 'result') {
          out.ok = !m.is_error;
          out.reply = m.result;
          out.cost = m.total_cost_usd;
          if (m.is_error) out.error = m.result;
        }
      }
    });
    p.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    p.on('close', () => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      // stderr claude — предупреждения (про коннекторы и т.п.), а не причина: берём его последним.
      if (!out.ok && !out.error) out.error = err.trim().split('\n').filter((l) => !/connectors are disabled/.test(l)).slice(-2).join(' ') || 'claude не ответил';
      resolve(out);
    });
  });
}
