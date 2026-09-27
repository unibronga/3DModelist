// Окно настроек и «готовность» приложения: рабочая папка, Claude (подписка
// или ключ API), fal.ai, Blender, язык ответов агента.
//
// Ключи на страницу не приходят: сервер отдаёт только «задан, …abcd». Поле
// ключа пустое — значит «оставить как есть»; стереть — отдельной кнопкой.

import { $, el, api, toast, segment } from './ui.js';

export const H = { health: null, settings: null };
let onChange = () => {};
export const setOnChange = (fn) => { onChange = fn; };

// Мостик окна приложения (electron/preload.cjs); в браузере его нет.
const host = window.modelist || null;

export async function refreshHealth() {
  H.health = await api('/health');
  return H.health;
}

// Что ещё не настроено — одной строкой на пункт. Пусто — можно работать.
export function blockers(h = H.health) {
  if (!h) return ['нет связи с сервером'];
  const out = [];
  if (!h.workspace.set) out.push('рабочая папка не выбрана');
  else if (!h.workspace.ready) out.push('рабочая папка не подготовлена');
  if (!h.claude.bin) out.push('не найден Claude Code');
  else if (h.claude.mode === 'api' && !h.claude.key) out.push('не задан ключ Anthropic API');
  if (!h.python) out.push('нет python3');
  return out;
}

function line(ok, text) {
  return el('div', { class: 'chk ' + (ok === true ? 'ok' : ok === false ? 'bad' : 'wait') },
    el('span', { class: 'chk-mark' }, ok === true ? '✓' : ok === false ? '!' : '…'), el('span', {}, text));
}

function link(href, text) {
  return el('a', { href, target: '_blank', rel: 'noreferrer' }, text);
}

export async function openSettings(focus) {
  const [s, h] = await Promise.all([api('/settings'), refreshHealth()]);
  H.settings = s;
  const draft = {
    workspace: s.workspace || h.defaultWorkspace,
    language: s.language,
    claude: { mode: s.claude.mode, bin: s.claude.bin, configDir: s.claude.configDir, apiKey: '' },
    fal: { key: '' },
    blender: { bin: s.blender.bin, port: s.blender.port },
    clear: { claude: false, fal: false },
  };

  const modal = $('#modal');
  const results = { claude: null, fal: null };

  async function save(quiet = false) {
    const body = {
      workspace: draft.workspace,
      language: draft.language,
      claude: { mode: draft.claude.mode, bin: draft.claude.bin, configDir: draft.claude.configDir },
      blender: { bin: draft.blender.bin, port: Number(draft.blender.port) },
    };
    if (draft.claude.apiKey.trim()) body.claude.apiKey = draft.claude.apiKey.trim();
    else if (draft.clear.claude) body.claude.apiKey = null;
    if (draft.fal.key.trim()) body.fal = { key: draft.fal.key.trim() };
    else if (draft.clear.fal) body.fal = { key: null };
    H.settings = await api('/settings', { method: 'PATCH', body });
    draft.claude.apiKey = '';
    draft.fal.key = '';
    draft.clear = { claude: false, fal: false };
    await refreshHealth();
    if (!quiet) toast('Сохранено');
    onChange();
  }

  const act = (fn) => async (e) => {
    const b = e.currentTarget;
    const label = b.textContent;
    b.disabled = true;
    b.textContent = 'Секунду…';
    try { await fn(); } catch (err) { toast(err.message, true); }
    b.disabled = false;
    b.textContent = label;
    draw();
  };

  function draw() {
    const hs = H.health;
    const st = H.settings;
    const w = hs.workspace;

    // ── рабочая папка ──
    const wsInput = el('input', { class: 'input', value: draft.workspace, oninput: (e) => { draft.workspace = e.target.value; } });
    const wsState = !w.set ? line(null, 'не выбрана')
      : !w.exists ? line(null, 'папки ещё нет — «Подготовить» создаст её')
        : w.ready ? line(true, `готова: скилов ${w.skills}`)
          : line(false, 'не хватает набора: ' + (w.missing?.join(', ') || 'скилов'));
    const secWs = el('section', { class: 'set', id: 'set-ws' },
      el('h3', {}, 'Рабочая папка'),
      el('p', { class: 'muted' }, 'Здесь лежат референсы, скрипты, модели и набор пайплайна для агента. Можно выбрать папку, где уже шла работа: студия только доложит недостающее и ничего не перезапишет.'),
      el('div', { class: 'row' }, wsInput,
        host && el('button', { class: 'btn', onclick: act(async () => { const p = await host.pickFolder(); if (p) draft.workspace = p; }) }, 'Выбрать…')),
      wsState,
      el('button', {
        class: 'btn primary',
        onclick: act(async () => {
          await save(true);
          const r = await api('/workspace/prepare', { method: 'POST' });
          await refreshHealth();
          toast(r.added.length ? `Разложено файлов: ${r.added.length}` : 'Всё уже на месте');
        }),
      }, 'Сохранить и подготовить папку'));

    // ── Claude ──
    const c = draft.claude;
    const keyState = st.claude.apiKey.set ? `ключ задан (${st.claude.apiKey.tail})` : 'ключ не задан';
    const cr = results.claude;
    const secClaude = el('section', { class: 'set', id: 'set-claude' },
      el('h3', {}, 'Claude — агент-моделист'),
      el('p', { class: 'muted' }, 'Агент — это Claude Code, запущенный без окна. Нужна программа ', el('code', {}, 'claude'),
        ' (', link('https://docs.claude.com/en/docs/claude-code/setup', 'установка'), ').'),
      segment([
        ['subscription', 'По подписке', 'Claude Pro / Max: платы за агента нет, тратится лимит подписки'],
        ['api', 'По ключу API', 'Anthropic API: платишь за токены, сумма видна в каждой задаче'],
      ], c.mode, (v) => { c.mode = v; draw(); }, 'full'),
      c.mode === 'subscription'
        ? el('p', { class: 'muted' }, 'Войти один раз: открой Терминал, набери ', el('code', {}, 'claude'), ' и в нём ', el('code', {}, '/login'), '. Дальше студия пользуется этим входом.')
        : el('div', { class: 'field' },
          el('div', { class: 'label' }, 'Ключ Anthropic API', el('span', { class: 'hint' }, keyState)),
          el('div', { class: 'row' },
            el('input', { class: 'input', type: 'password', placeholder: st.claude.apiKey.set ? 'оставить как есть' : 'sk-ant-…', autocomplete: 'off', oninput: (e) => { c.apiKey = e.target.value; } }),
            st.claude.apiKey.set && el('button', { class: 'btn ghost', onclick: act(async () => { draft.clear.claude = true; await save(); }) }, 'Стереть')),
          el('p', { class: 'muted' }, 'Ключ берётся в ', link('https://console.anthropic.com/settings/keys', 'консоли Anthropic'), '. Хранится только на этом компьютере.')),
      el('details', { class: 'more' },
        el('summary', {}, 'Путь к claude и профиль'),
        el('div', { class: 'field' }, el('div', { class: 'label' }, 'Программа claude'),
          el('input', { class: 'input', value: c.bin, placeholder: '/opt/homebrew/bin/claude', oninput: (e) => { c.bin = e.target.value; } })),
        el('div', { class: 'field' }, el('div', { class: 'label' }, 'Папка профиля Claude Code', el('span', { class: 'hint' }, 'необязательно')),
          el('input', { class: 'input', value: c.configDir, placeholder: 'обычный профиль (~/.claude)', oninput: (e) => { c.configDir = e.target.value; } }),
          el('p', { class: 'muted' }, 'Для тех, у кого несколько аккаунтов Claude Code: какой из профилей брать.'))),
      hs.claude.bin ? line(true, 'claude найден') : line(false, 'claude не найден — установи Claude Code или укажи путь'),
      cr && (cr.ok
        ? line(true, `на связи: ${cr.model || ''}${cr.source && cr.source !== 'none' ? ' · ' + cr.source : ''}${cr.limit5h != null ? ` · лимит подписки ${Math.round(cr.limit5h * 100)}%` : ''}`)
        : line(false, cr.error || 'не ответил')),
      el('button', {
        class: 'btn',
        onclick: act(async () => { await save(true); results.claude = await api('/check/claude', { method: 'POST' }); }),
      }, 'Сохранить и проверить'));

    // ── fal.ai ──
    const fr = results.fal;
    const falState = st.fal.key.set ? `ключ задан (${st.fal.key.tail})`
      : hs.fal.key ? `берётся из ${hs.fal.source === 'env' ? 'переменной FAL_KEY' : '.mcp.json рабочей папки'}` : 'ключ не задан';
    const secFal = el('section', { class: 'set', id: 'set-fal' },
      el('h3', {}, 'fal.ai — генераторы'),
      el('p', { class: 'muted' }, 'Нужен только для пути «Генератор» (Tripo, Trellis, Hunyuan). Платно, по факту генерации. Ключ — на ',
        link('https://fal.ai/dashboard/keys', 'fal.ai/dashboard/keys'), '.'),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, 'Ключ fal.ai', el('span', { class: 'hint' }, falState)),
        el('div', { class: 'row' },
          el('input', { class: 'input', type: 'password', placeholder: st.fal.key.set ? 'оставить как есть' : 'ключ fal', autocomplete: 'off', oninput: (e) => { draft.fal.key = e.target.value; } }),
          st.fal.key.set && el('button', { class: 'btn ghost', onclick: act(async () => { draft.clear.fal = true; await save(); }) }, 'Стереть'))),
      fr && (fr.ok ? line(true, 'fal.ai принял ключ') : line(false, fr.error)),
      el('button', { class: 'btn', onclick: act(async () => { await save(true); results.fal = await api('/check/fal', { method: 'POST' }); }) }, 'Сохранить и проверить'));

    // ── Blender ──
    const b = draft.blender;
    const secBl = el('section', { class: 'set', id: 'set-blender' },
      el('h3', {}, 'Blender'),
      el('p', { class: 'muted' }, 'Агент строит модель в Blender (4.2 и новее). Студия запускает его со своим сервером — ставить аддоны не нужно. ',
        link('https://www.blender.org/download/', 'Скачать Blender'), '.'),
      el('div', { class: 'field' }, el('div', { class: 'label' }, 'Программа Blender'),
        el('input', { class: 'input', value: b.bin, placeholder: '/Applications/Blender.app/Contents/MacOS/Blender', oninput: (e) => { b.bin = e.target.value; } })),
      el('div', { class: 'field' }, el('div', { class: 'label' }, 'Порт', el('span', { class: 'hint' }, 'обычно 9876')),
        el('input', { class: 'input', style: 'max-width:120px', value: b.port, inputmode: 'numeric', oninput: (e) => { b.port = e.target.value; } })),
      hs.blender.online ? line(true, `на связи: Blender ${hs.blender.version || ''}${hs.blender.background ? ' (без окна)' : ''}`)
        : hs.blender.bin ? line(null, 'не запущен') : line(false, 'Blender не найден — укажи путь'),
      hs.python ? null : line(false, 'нет python3 — нужен для инструментов агента (xcode-select --install)'),
      el('div', { class: 'row' },
        el('button', { class: 'btn', disabled: hs.blender.online, onclick: act(async () => { await save(true); const r = await api('/blender/launch', { method: 'POST', body: {} }); await refreshHealth(); if (r.error) toast(r.error, true); }) }, 'Запустить Blender'),
        el('button', { class: 'btn ghost', disabled: hs.blender.online, onclick: act(async () => { await save(true); const r = await api('/blender/launch', { method: 'POST', body: { background: true } }); await refreshHealth(); if (r.error) toast(r.error, true); }) }, 'Без окна')));

    // ── язык ──
    const secLang = el('section', { class: 'set' },
      el('h3', {}, 'Язык ответов агента'),
      segment([['ru', 'Русский'], ['en', 'English']], draft.language, (v) => { draft.language = v; draw(); }, 'full'));

    const todo = blockers(hs);
    modal.replaceChildren(el('div', { class: 'sheet' },
      el('div', { class: 'sheet-head' },
        el('div', {}, el('div', { class: 'panel-title' }, 'Настройки'),
          el('div', { class: 'panel-sub' }, todo.length ? 'Осталось: ' + todo.join(' · ') : 'Всё готово к работе')),
        el('button', { class: 'btn ghost', onclick: close }, 'Закрыть')),
      el('div', { class: 'sheet-body' }, secWs, secClaude, secFal, secBl, secLang),
      el('div', { class: 'sheet-foot' },
        el('span', { class: 'muted' }, `3DModelist ${hs.version} · настройки: ${st.home}`),
        el('button', { class: 'btn primary', onclick: act(async () => { await save(); }) }, 'Сохранить'))));
  }

  function close() {
    modal.hidden = true;
    document.removeEventListener('keydown', esc);
    onChange();
  }
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  modal.onclick = (e) => { if (e.target === modal) close(); };

  draw();
  modal.hidden = false;
  if (focus) $('#set-' + focus)?.scrollIntoView({ block: 'start' });
}
