// Окно настроек и «готовность» приложения: интерфейс (язык, тема, размер),
// рабочая папка, Claude (подписка или ключ API), fal.ai, Blender.
//
// Ключи на страницу не приходят: сервер отдаёт только «задан, …abcd». Поле
// ключа пустое — значит «оставить как есть»; стереть — отдельной кнопкой.

import { $, el, api, toast, segment, errText } from './ui.js';
import { t, LANGS, getLang, setLang } from './i18n.js';
import { applyTheme, applyScale } from './prefs.js';

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
  if (!h) return [t('block.noServer')];
  const out = [];
  if (!h.workspace.set) out.push(t('block.noWorkspace'));
  else if (!h.workspace.ready) out.push(t('block.wsNotReady'));
  if (!h.claude.bin) out.push(t('block.noClaude'));
  else if (h.claude.mode === 'api' && !h.claude.key) out.push(t('block.noApiKey'));
  if (!h.python) out.push(t('block.noPython'));
  return out;
}

function line(ok, text) {
  return el('div', { class: 'chk ' + (ok === true ? 'ok' : ok === false ? 'bad' : 'wait') },
    el('span', { class: 'chk-mark' }, ok === true ? '✓' : ok === false ? '!' : '…'), el('span', {}, text));
}

const link = (href, text) => el('a', { href, target: '_blank', rel: 'noreferrer' }, text);

// Выбор языка: имя языка — на самом языке.
export function langSelect(onPick) {
  const sel = el('select', { class: 'select', onchange: (e) => onPick(e.target.value) },
    ...Object.entries(LANGS).map(([code, name]) => el('option', { value: code }, name)));
  sel.value = getLang();
  return sel;
}

// Результат проверки Claude — одной строкой.
export function claudeLine(cr) {
  if (!cr) return null;
  if (cr.ok) {
    const bits = [cr.model || ''];
    if (cr.limit5h != null) bits.push(t('claude.limit', { p: Math.round(cr.limit5h * 100) }));
    return line(true, t('claude.online', { info: bits.filter(Boolean).join(' · ') }));
  }
  return line(false, errText(cr));
}

export async function openSettings(focus) {
  const [s, h] = await Promise.all([api('/settings'), refreshHealth()]);
  H.settings = s;
  const draft = {
    workspace: s.workspace || h.defaultWorkspace,
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
    if (!quiet) toast(t('settings.saved'));
    onChange();
  }

  // Интерфейс применяется сразу и сохраняется сразу — без кнопки «Сохранить».
  async function saveUi(patch) {
    H.settings = await api('/settings', { method: 'PATCH', body: { ui: patch } });
  }

  const act = (fn) => async (e) => {
    const b = e.currentTarget;
    const label = b.textContent;
    b.disabled = true;
    b.textContent = t('common.wait');
    try { await fn(); } catch (err) { toast(errText(err), true); }
    b.disabled = false;
    b.textContent = label;
    draw();
  };

  function draw() {
    const hs = H.health;
    const st = H.settings;
    const w = hs.workspace;
    const ui = st.ui || {};

    // ── интерфейс ──
    const scaleLabel = el('span', { class: 'hint' }, Math.round((ui.scale || 1) * 100) + '%');
    const secUi = el('section', { class: 'set', id: 'set-ui' },
      el('h3', {}, t('set.ui')),
      el('div', { class: 'set-grid' },
        el('span', { class: 'muted' }, t('set.lang')),
        langSelect(async (code) => { setLang(code); await saveUi({ lang: code }); draw(); }),
        el('span', { class: 'muted' }, t('set.theme')),
        segment([['light', t('theme.light')], ['dark', t('theme.dark')], ['system', t('theme.system')]],
          ui.theme || 'system', async (v) => { applyTheme(v); await saveUi({ theme: v }); draw(); }, 'full'),
        el('span', { class: 'muted' }, t('set.scale')),
        el('div', { class: 'row' },
          el('input', {
            class: 'range', type: 'range', min: 0.8, max: 1.4, step: 0.05, value: ui.scale || 1,
            // Тянем — меняется сразу; отпустили — сохраняем.
            oninput: (e) => { applyScale(e.target.value); scaleLabel.textContent = Math.round(e.target.value * 100) + '%'; },
            onchange: async (e) => { await saveUi({ scale: Number(e.target.value) }); },
          }),
          scaleLabel,
          el('button', { class: 'btn ghost', onclick: async () => { applyScale(1); await saveUi({ scale: 1 }); draw(); } }, '100%'))),
      el('p', { class: 'muted' }, t('set.lang.agentHint')));

    // ── рабочая папка ──
    const wsInput = el('input', { class: 'input', value: draft.workspace, oninput: (e) => { draft.workspace = e.target.value; } });
    const wsState = !w.set ? line(null, t('ws.notSet'))
      : !w.exists ? line(null, t('ws.willCreate'))
        : w.ready ? line(true, t('ws.ready', { n: w.skills }))
          : line(false, t('ws.missing', { list: w.missing?.join(', ') || 'skills' }));
    const secWs = el('section', { class: 'set', id: 'set-ws' },
      el('h3', {}, t('ws.title')),
      el('p', { class: 'muted' }, t('ws.text')),
      el('div', { class: 'row' }, wsInput,
        host && el('button', { class: 'btn', onclick: act(async () => { const p = await host.pickFolder(); if (p) draft.workspace = p; }) }, t('common.choose'))),
      wsState,
      el('button', {
        class: 'btn primary',
        onclick: act(async () => {
          await save(true);
          const r = await api('/workspace/prepare', { method: 'POST' });
          await refreshHealth();
          toast(r.added.length ? t('ws.added', { n: r.added.length }) : t('ws.nothing'));
        }),
      }, t('ws.prepareSave')));

    // ── Claude ──
    const c = draft.claude;
    const keyState = st.claude.apiKey.set ? t('key.set', { tail: st.claude.apiKey.tail }) : t('key.notSet');
    const secClaude = el('section', { class: 'set', id: 'set-claude' },
      el('h3', {}, t('claude.title')),
      el('p', { class: 'muted' }, t('claude.what'), ' ', link('https://docs.claude.com/en/docs/claude-code/setup', t('claude.install'))),
      segment([
        ['subscription', t('claude.sub'), t('claude.sub.hint')],
        ['api', t('claude.api'), t('claude.api.hint')],
      ], c.mode, (v) => { c.mode = v; draw(); }, 'full'),
      c.mode === 'subscription'
        ? el('div', { class: 'field' },
          el('p', { class: 'muted' }, t('claude.loginText')),
          host && hs.claude.bin && el('button', { class: 'btn', style: 'align-self:flex-start', onclick: () => host.claudeLogin() }, t('claude.loginBtn')))
        : el('div', { class: 'field' },
          el('div', { class: 'label' }, t('claude.apiKey'), el('span', { class: 'hint' }, keyState)),
          el('div', { class: 'row' },
            el('input', { class: 'input', type: 'password', placeholder: st.claude.apiKey.set ? t('key.keep') : 'sk-ant-…', autocomplete: 'off', oninput: (e) => { c.apiKey = e.target.value; } }),
            st.claude.apiKey.set && el('button', { class: 'btn ghost', onclick: act(async () => { draft.clear.claude = true; await save(); }) }, t('key.clear'))),
          el('p', { class: 'muted' }, t('claude.apiWhere'), ' ', link('https://console.anthropic.com/settings/keys', 'console.anthropic.com'))),
      el('details', { class: 'more' },
        el('summary', {}, t('claude.more')),
        el('div', { class: 'field' }, el('div', { class: 'label' }, t('claude.bin')),
          el('input', { class: 'input', value: c.bin, placeholder: '/opt/homebrew/bin/claude', oninput: (e) => { c.bin = e.target.value; } })),
        el('div', { class: 'field' }, el('div', { class: 'label' }, t('claude.profile'), el('span', { class: 'hint' }, t('form.optional'))),
          el('input', { class: 'input', value: c.configDir, placeholder: '~/.claude', oninput: (e) => { c.configDir = e.target.value; } }),
          el('p', { class: 'muted' }, t('claude.profile.hint')))),
      hs.claude.bin ? line(true, t('claude.found')) : line(false, t('claude.notFound')),
      claudeLine(results.claude),
      el('button', {
        class: 'btn',
        onclick: act(async () => { await save(true); results.claude = await api('/check/claude', { method: 'POST', body: {} }); }),
      }, t('common.saveCheck')));

    // ── fal.ai ──
    const fr = results.fal;
    const falState = st.fal.key.set ? t('key.set', { tail: st.fal.key.tail })
      : hs.fal.key ? t(hs.fal.source === 'env' ? 'fal.fromEnv' : 'fal.fromMcp') : t('key.notSet');
    const secFal = el('section', { class: 'set', id: 'set-fal' },
      el('h3', {}, t('fal.title')),
      el('p', { class: 'muted' }, t('fal.text'), ' ', link('https://fal.ai/dashboard/keys', 'fal.ai/dashboard/keys')),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, t('fal.key'), el('span', { class: 'hint' }, falState)),
        el('div', { class: 'row' },
          el('input', { class: 'input', type: 'password', placeholder: st.fal.key.set ? t('key.keep') : 'fal key', autocomplete: 'off', oninput: (e) => { draft.fal.key = e.target.value; } }),
          st.fal.key.set && el('button', { class: 'btn ghost', onclick: act(async () => { draft.clear.fal = true; await save(); }) }, t('key.clear')))),
      fr && (fr.ok ? line(true, t('fal.ok')) : line(false, errText(fr))),
      el('button', { class: 'btn', onclick: act(async () => { await save(true); results.fal = await api('/check/fal', { method: 'POST' }); }) }, t('common.saveCheck')));

    // ── Blender ──
    const b = draft.blender;
    const secBl = el('section', { class: 'set', id: 'set-blender' },
      el('h3', {}, t('bl.title')),
      el('p', { class: 'muted' }, t('bl.text'), ' ', link('https://www.blender.org/download/', t('bl.download'))),
      el('div', { class: 'field' }, el('div', { class: 'label' }, t('bl.where')),
        el('input', { class: 'input', value: b.bin, placeholder: '/Applications/Blender.app/Contents/MacOS/Blender', oninput: (e) => { b.bin = e.target.value; } })),
      hs.blender.online ? line(true, t('bl.running', { v: hs.blender.version || '' }) + (hs.blender.background ? ' — ' + t('blender.headless') : ''))
        : hs.blender.bin ? line(null, t('bl.willStart')) : line(false, t('bl.notFound')),
      hs.python ? null : line(false, t('block.noPython')),
      el('div', { class: 'row' },
        el('button', {
          class: 'btn', disabled: hs.blender.online, title: t('bl.openWindow.hint'),
          onclick: act(async () => { await save(true); const r = await api('/blender/launch', { method: 'POST', body: {} }); await refreshHealth(); if (r.code) toast(errText(r), true); }),
        }, t('bl.openWindow'))),
      el('details', { class: 'more' },
        el('summary', {}, t('common.advanced')),
        el('div', { class: 'field' }, el('div', { class: 'label' }, t('bl.port'), el('span', { class: 'hint' }, t('bl.port.usual'))),
          el('input', { class: 'input', style: 'max-width:120px', value: b.port, inputmode: 'numeric', oninput: (e) => { b.port = e.target.value; } }),
          el('p', { class: 'muted' }, t('bl.port.hint')))));

    const todo = blockers(hs);
    modal.replaceChildren(el('div', { class: 'sheet' },
      el('div', { class: 'sheet-head' },
        el('div', {}, el('div', { class: 'panel-title' }, t('settings.title')),
          el('div', { class: 'panel-sub' }, todo.length ? t('settings.left', { list: todo.join(' · ') }) : t('settings.allReady'))),
        el('button', { class: 'btn ghost', onclick: close }, t('common.close'))),
      el('div', { class: 'sheet-body' }, secUi, secWs, secClaude, secFal, secBl),
      el('div', { class: 'sheet-foot' },
        el('span', { class: 'muted' }, t('settings.foot', { v: hs.version, home: st.home })),
        el('button', { class: 'btn primary', onclick: act(async () => { await save(); }) }, t('common.save')))));
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
