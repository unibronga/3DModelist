// Окно первого запуска: имя, версия и настройка по шагам.
//
//   1. Рабочая папка   — где живут модели (обязательно)
//   2. Claude          — кто строит (обязательно: подписка или ключ API)
//   3. Blender         — в чём строит агент скриптом (можно пропустить, если только генераторы)
//   4. Генераторы      — ключ fal.ai (можно пропустить)
//   5. Готово          — сводка и «Начать работу»
//
// Пройденный мастер отмечается в настройках (onboarded) и больше не
// показывается; всё то же самое потом правится в «Настройках».

import { el, api, toast, segment } from './ui.js';
import { refreshHealth, H } from './settings.js';
import appIcon from './app-icon.png';

const host = window.modelist || null;

const STEPS = [
  { key: 'ws', title: 'Папка' },
  { key: 'claude', title: 'Claude' },
  { key: 'blender', title: 'Blender', optional: true },
  { key: 'fal', title: 'Генераторы', optional: true },
];

function link(href, text) {
  return el('a', { href, target: '_blank', rel: 'noreferrer' }, text);
}

function status(kind, text) {
  return el('div', { class: 'chk ' + kind }, el('span', { class: 'chk-mark' }, kind === 'ok' ? '✓' : kind === 'bad' ? '!' : '…'), el('span', {}, text));
}

export async function openWelcome({ onDone } = {}) {
  const meta = await api('/meta');
  let s = await api('/settings');
  await refreshHealth();

  const st = {
    step: 0,
    done: {},                      // шаг → true, когда проверен
    skipped: {},
    ws: s.workspace || H.health.defaultWorkspace,
    claude: { mode: s.claude.mode, key: '', check: null },
    blender: { bin: s.blender.bin, check: null },
    fal: { key: '', check: null },
    busy: false,
  };
  // Уже настроенное отмечаем сразу: повторный мастер не заставляет проходить всё заново.
  if (H.health.workspace.ready) st.done.ws = true;

  const back = el('div', { class: 'welcome-back' });
  document.body.append(back);

  const go = (i) => { st.step = i; draw(); };
  const next = () => go(st.step + 1);

  async function run(fn) {
    if (st.busy) return;
    st.busy = true;
    draw();
    try { await fn(); } catch (e) { toast(e.message, true); }
    st.busy = false;
    draw();
  }

  // ── шаги ─────────────────────────────────────────────────────────────────
  function stepWs() {
    const w = H.health.workspace;
    const ready = st.done.ws && w.ready && w.path === st.ws;
    return {
      title: 'Где будут жить модели',
      body: [
        el('p', {}, 'Папка для референсов, скриптов и готовых файлов. Туда же студия положит инструкции и скилы для агента. Можно выбрать папку, где уже шла работа: ничего не перезапишется.'),
        el('div', { class: 'row' },
          el('input', { class: 'input', value: st.ws, oninput: (e) => { st.ws = e.target.value; st.done.ws = false; } }),
          host && el('button', { class: 'btn', onclick: () => run(async () => { const p = await host.pickFolder(); if (p) { st.ws = p; st.done.ws = false; } }) }, 'Выбрать…')),
        ready ? status('ok', `Папка готова: скилов ${w.skills}`) : null,
      ],
      primary: ready
        ? { text: 'Дальше', onclick: next }
        : {
          text: 'Подготовить папку',
          onclick: () => run(async () => {
            s = await api('/settings', { method: 'PATCH', body: { workspace: st.ws } });
            st.ws = s.workspace;
            await api('/workspace/prepare', { method: 'POST' });
            await refreshHealth();
            st.done.ws = H.health.workspace.ready;
            if (st.done.ws) next();
          }),
        },
    };
  }

  function stepClaude() {
    const c = st.claude;
    const found = H.health.claude.bin;
    const chk = c.check;
    const body = [
      el('p', {}, 'Модель строит агент — Claude. Подключить можно двумя способами:'),
      segment([
        ['subscription', 'По подписке', 'Claude Pro или Max: отдельной платы нет'],
        ['api', 'По ключу API', 'Anthropic API: платишь за работу агента'],
      ], c.mode, (v) => { c.mode = v; c.check = null; st.done.claude = false; draw(); }, 'full'),
    ];
    if (!found) {
      body.push(status('bad', 'Не найдена программа Claude Code — без неё агент не запустится'),
        el('p', { class: 'muted' }, 'Установи по ', link('https://docs.claude.com/en/docs/claude-code/setup', 'инструкции'), ' и нажми «Проверить».'));
    }
    if (c.mode === 'subscription') {
      body.push(el('p', { class: 'muted' }, 'Войти нужно один раз: в Терминале программа ', el('code', {}, 'claude'), ', в ней команда ', el('code', {}, '/login'), '.'),
        host && found && el('button', { class: 'btn', onclick: () => host.claudeLogin() }, 'Открыть Терминал и войти'));
    } else {
      body.push(el('div', { class: 'field' },
        el('div', { class: 'label' }, 'Ключ Anthropic API', el('span', { class: 'hint' }, s.claude.apiKey.set ? `задан (${s.claude.apiKey.tail})` : link('https://console.anthropic.com/settings/keys', 'взять ключ'))),
        el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: s.claude.apiKey.set ? 'оставить как есть' : 'sk-ant-…', oninput: (e) => { c.key = e.target.value; } })));
    }
    if (chk) body.push(chk.ok ? status('ok', 'Claude на связи') : status('bad', chk.error || 'Claude не ответил'));
    return {
      title: 'Подключи Claude',
      body,
      primary: st.done.claude
        ? { text: 'Дальше', onclick: next }
        : {
          text: 'Проверить',
          onclick: () => run(async () => {
            const body = { claude: { mode: c.mode } };
            if (c.mode === 'api' && c.key.trim()) body.claude.apiKey = c.key.trim();
            s = await api('/settings', { method: 'PATCH', body });
            await refreshHealth();
            c.check = await api('/check/claude', { method: 'POST' });
            st.done.claude = !!c.check.ok;
          }),
        },
      secondary: !st.done.claude && { text: 'Настрою позже', onclick: () => { st.skipped.claude = true; next(); } },
    };
  }

  function stepBlender() {
    const b = st.blender;
    const chk = b.check;
    return {
      title: 'Blender — мастерская агента',
      body: [
        el('p', {}, 'Путь «Агент скриптом» строит модель в Blender: размеры, фаски, материалы, выдача GLB и кадры для сверки с референсом. Окно Blender тебе не понадобится — студия сама запускает его без окна, когда агент берётся за работу, и выключает при выходе.'),
        el('p', { class: 'muted' }, 'Нужен Blender 4.2 или новее — ', link('https://www.blender.org/download/', 'скачать'), '. Если будешь делать модели только генератором — шаг можно пропустить.'),
        el('div', { class: 'field' }, el('div', { class: 'label' }, 'Где установлен Blender'),
          el('input', { class: 'input', value: b.bin, placeholder: '/Applications/Blender.app/Contents/MacOS/Blender', oninput: (e) => { b.bin = e.target.value; b.check = null; st.done.blender = false; draw(); } })),
        chk && (chk.ok ? status('ok', `Blender ${chk.version} найден`)
          : status('bad', chk.old ? `Blender ${chk.version} — нужен 4.2 или новее` : chk.error)),
      ],
      primary: st.done.blender
        ? { text: 'Дальше', onclick: next }
        : {
          text: 'Проверить',
          onclick: () => run(async () => {
            s = await api('/settings', { method: 'PATCH', body: { blender: { bin: b.bin } } });
            b.check = await api('/blender/version', { method: 'POST', body: { bin: b.bin } });
            st.done.blender = !!b.check.ok;
          }),
        },
      secondary: !st.done.blender && { text: 'Пропустить', onclick: () => { st.skipped.blender = true; next(); } },
    };
  }

  function stepFal() {
    const f = st.fal;
    const chk = f.check;
    const inherited = H.health.fal.key && !s.fal.key.set;
    return {
      title: 'Генераторы — по желанию',
      body: [
        el('p', {}, 'Путь «Генератор» делает форму нейросетью по картинке — для персонажей и органики: Tripo P2, Trellis 2, Hunyuan 3.1. Работает через fal.ai, платно за каждую модель — от $0.23 до $1.10, цена видна на кнопке до запуска.'),
        el('div', { class: 'field' },
          el('div', { class: 'label' }, 'Ключ fal.ai', el('span', { class: 'hint' },
            s.fal.key.set ? `задан (${s.fal.key.tail})` : inherited ? 'уже есть в рабочей папке' : link('https://fal.ai/dashboard/keys', 'взять ключ'))),
          el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: s.fal.key.set || inherited ? 'оставить как есть' : 'ключ fal', oninput: (e) => { f.key = e.target.value; } })),
        chk && (chk.ok ? status('ok', 'fal.ai принял ключ') : status('bad', chk.error)),
      ],
      primary: st.done.fal
        ? { text: 'Дальше', onclick: next }
        : {
          text: 'Проверить',
          onclick: () => run(async () => {
            if (f.key.trim()) s = await api('/settings', { method: 'PATCH', body: { fal: { key: f.key.trim() } } });
            f.check = await api('/check/fal', { method: 'POST' });
            st.done.fal = !!f.check.ok;
          }),
        },
      secondary: !st.done.fal && { text: 'Пропустить', onclick: () => { st.skipped.fal = true; next(); } },
    };
  }

  function stepDone() {
    const row = (ok, name, note) => el('div', { class: 'sum-row' },
      el('span', { class: 'chk-mark ' + (ok ? 'ok' : '') }, ok ? '✓' : '–'), el('b', {}, name), el('span', { class: 'muted' }, note));
    const canWork = st.done.ws && st.done.claude;
    return {
      title: canWork ? 'Всё готово' : 'Почти готово',
      body: [
        row(st.done.ws, 'Папка', st.ws),
        row(st.done.claude, 'Claude', st.done.claude ? (st.claude.mode === 'api' ? 'по ключу API' : 'по подписке') : 'не подключён — агент не запустится'),
        row(st.done.blender, 'Blender', st.done.blender ? 'агент строит скриптом' : 'пропущен — только генераторы'),
        row(st.done.fal, 'Генераторы', st.done.fal ? 'ключ fal.ai на месте' : 'пропущены — только агент скриптом'),
        el('p', { class: 'muted' }, 'Всё это меняется потом в «Настройках» внизу слева.'),
      ],
      primary: {
        text: 'Начать работу',
        onclick: () => run(async () => {
          await api('/settings', { method: 'PATCH', body: { onboarded: true } });
          close();
        }),
      },
    };
  }

  // ── отрисовка ────────────────────────────────────────────────────────────
  function draw() {
    const view = [stepWs, stepClaude, stepBlender, stepFal, stepDone][st.step]();
    const locked = (i) => i > 0 && !st.done.ws;   // без папки дальше не пройти

    back.replaceChildren(el('div', { class: 'welcome' },
      el('div', { class: 'welcome-head' },
        el('img', { class: 'welcome-icon', src: appIcon, alt: '' }),
        el('div', {},
          el('h1', { class: 'welcome-title' },
            el('span', { class: 'welcome-name' }, el('span', { class: 'name-3d' }, '3D'), 'Modelist'),
            el('span', { class: 'welcome-version' }, meta.version)),
          el('p', { class: 'welcome-sub' }, 'Референс → low-poly модель. Агент строит её по этапам, ты смотришь и отвечаешь.'))),
      el('div', { class: 'steps' }, ...STEPS.map((x, i) => el('button', {
        class: 'step' + (i === st.step ? ' on' : '') + (st.done[x.key] ? ' done' : '') + (st.skipped[x.key] && !st.done[x.key] ? ' skip' : ''),
        disabled: locked(i) || st.busy,
        onclick: () => go(i),
      }, el('span', { class: 'step-n' }, st.done[x.key] ? '✓' : i + 1), x.title, x.optional && el('span', { class: 'step-opt' }, 'по желанию')))),
      el('div', { class: 'welcome-body' }, el('h2', {}, view.title), ...view.body),
      el('div', { class: 'welcome-foot' },
        st.step > 0 && st.step < 4 ? el('button', { class: 'btn ghost', disabled: st.busy, onclick: () => go(st.step - 1) }, '← Назад') : el('span'),
        el('div', { class: 'row' },
          view.secondary ? el('button', { class: 'btn ghost', disabled: st.busy, onclick: view.secondary.onclick }, view.secondary.text) : null,
          el('button', { class: 'btn primary', disabled: st.busy, onclick: view.primary.onclick }, st.busy ? 'Секунду…' : view.primary.text)))));
  }

  function close() {
    back.remove();
    onDone?.();
  }

  draw();
}
