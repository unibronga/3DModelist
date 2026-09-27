// Окно первого запуска: имя, версия, язык и настройка по шагам.
//
//   1. Рабочая папка   — где живут модели (обязательно)
//   2. Claude          — кто строит (обязательно: подписка или ключ API)
//   3. Blender         — в чём строит агент скриптом (можно пропустить, если только генераторы)
//   4. Генераторы      — ключ fal.ai (можно пропустить)
//   5. Готово          — сводка и «Начать работу»
//
// Пройденный мастер отмечается в настройках (onboarded) и больше не
// показывается; всё то же самое потом правится в «Настройках».

import { el, api, toast, segment, errText } from './ui.js';
import { t, setLang } from './i18n.js';
import { refreshHealth, H, langSelect, claudeLine } from './settings.js';
import brand from './brand.png';

const host = window.modelist || null;

const STEPS = [
  { key: 'ws', title: 'wz.step.ws' },
  { key: 'claude', title: 'wz.step.claude' },
  { key: 'blender', title: 'wz.step.blender', optional: true },
  { key: 'fal', title: 'wz.step.fal', optional: true },
];

const link = (href, text) => el('a', { href, target: '_blank', rel: 'noreferrer' }, text);

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
    try { await fn(); } catch (e) { toast(errText(e), true); }
    st.busy = false;
    draw();
  }

  // ── шаги ─────────────────────────────────────────────────────────────────
  function stepWs() {
    const w = H.health.workspace;
    const ready = st.done.ws && w.ready && w.path === st.ws;
    return {
      title: t('wz.ws.title'),
      body: [
        el('p', {}, t('wz.ws.text')),
        el('div', { class: 'row' },
          el('input', { class: 'input', value: st.ws, oninput: (e) => { st.ws = e.target.value; st.done.ws = false; } }),
          host && el('button', { class: 'btn', onclick: () => run(async () => { const p = await host.pickFolder(); if (p) { st.ws = p; st.done.ws = false; } }) }, t('common.choose'))),
        ready ? status('ok', t('ws.ready', { n: w.skills })) : null,
      ],
      primary: ready
        ? { text: t('common.next'), onclick: next }
        : {
          text: t('wz.ws.prepare'),
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
    const body = [
      el('p', {}, t('wz.claude.text')),
      segment([
        ['subscription', t('claude.sub'), t('claude.sub.hint')],
        ['api', t('claude.api'), t('claude.api.hint')],
      ], c.mode, (v) => { c.mode = v; c.check = null; st.done.claude = false; draw(); }, 'full'),
    ];
    if (!found) {
      body.push(status('bad', t('wz.claude.notFound')),
        el('p', { class: 'muted' }, t('wz.claude.install'), ' ', link('https://docs.claude.com/en/docs/claude-code/setup', t('claude.install'))));
    }
    if (c.mode === 'subscription') {
      body.push(el('p', { class: 'muted' }, t('claude.loginText')),
        host && found && el('button', { class: 'btn', onclick: () => host.claudeLogin() }, t('claude.loginBtn')));
    } else {
      body.push(el('div', { class: 'field' },
        el('div', { class: 'label' }, t('claude.apiKey'), el('span', { class: 'hint' }, s.claude.apiKey.set ? t('key.set', { tail: s.claude.apiKey.tail }) : link('https://console.anthropic.com/settings/keys', t('key.get')))),
        el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: s.claude.apiKey.set ? t('key.keep') : 'sk-ant-…', oninput: (e) => { c.key = e.target.value; } })));
    }
    body.push(claudeLine(c.check));
    return {
      title: t('wz.claude.title'),
      body,
      primary: st.done.claude
        ? { text: t('common.next'), onclick: next }
        : {
          text: t('common.check'),
          onclick: () => run(async () => {
            const patch = { claude: { mode: c.mode } };
            if (c.mode === 'api' && c.key.trim()) patch.claude.apiKey = c.key.trim();
            s = await api('/settings', { method: 'PATCH', body: patch });
            await refreshHealth();
            c.check = await api('/check/claude', { method: 'POST', body: {} });
            st.done.claude = !!c.check.ok;
          }),
        },
      secondary: !st.done.claude && { text: t('wz.later'), onclick: () => { st.skipped.claude = true; next(); } },
    };
  }

  function stepBlender() {
    const b = st.blender;
    const chk = b.check;
    return {
      title: t('wz.bl.title'),
      body: [
        el('p', {}, t('wz.bl.text')),
        el('p', { class: 'muted' }, t('wz.bl.need'), ' ', link('https://www.blender.org/download/', t('bl.download')), ' ', t('wz.bl.skip')),
        el('div', { class: 'field' }, el('div', { class: 'label' }, t('bl.where')),
          el('input', { class: 'input', value: b.bin, placeholder: '/Applications/Blender.app/Contents/MacOS/Blender', oninput: (e) => { b.bin = e.target.value; b.check = null; st.done.blender = false; draw(); } })),
        chk && (chk.ok ? status('ok', t('wz.bl.found', { v: chk.version }))
          : status('bad', chk.old ? t('wz.bl.old', { v: chk.version }) : errText(chk))),
      ],
      primary: st.done.blender
        ? { text: t('common.next'), onclick: next }
        : {
          text: t('common.check'),
          onclick: () => run(async () => {
            s = await api('/settings', { method: 'PATCH', body: { blender: { bin: b.bin } } });
            b.check = await api('/blender/version', { method: 'POST', body: { bin: b.bin } });
            st.done.blender = !!b.check.ok;
          }),
        },
      secondary: !st.done.blender && { text: t('wz.skip'), onclick: () => { st.skipped.blender = true; next(); } },
    };
  }

  function stepFal() {
    const f = st.fal;
    const chk = f.check;
    const inherited = H.health.fal.key && !s.fal.key.set;
    return {
      title: t('wz.fal.title'),
      body: [
        el('p', {}, t('wz.fal.text')),
        el('div', { class: 'field' },
          el('div', { class: 'label' }, t('fal.key'), el('span', { class: 'hint' },
            s.fal.key.set ? t('key.set', { tail: s.fal.key.tail }) : inherited ? t('wz.fal.inherited') : link('https://fal.ai/dashboard/keys', t('key.get')))),
          el('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: s.fal.key.set || inherited ? t('key.keep') : 'fal key', oninput: (e) => { f.key = e.target.value; } })),
        chk && (chk.ok ? status('ok', t('fal.ok')) : status('bad', errText(chk))),
      ],
      primary: st.done.fal
        ? { text: t('common.next'), onclick: next }
        : {
          text: t('common.check'),
          onclick: () => run(async () => {
            if (f.key.trim()) s = await api('/settings', { method: 'PATCH', body: { fal: { key: f.key.trim() } } });
            f.check = await api('/check/fal', { method: 'POST' });
            st.done.fal = !!f.check.ok;
          }),
        },
      secondary: !st.done.fal && { text: t('wz.skip'), onclick: () => { st.skipped.fal = true; next(); } },
    };
  }

  function stepDone() {
    const row = (ok, name, note) => el('div', { class: 'sum-row' },
      el('span', { class: 'chk-mark ' + (ok ? 'ok' : '') }, ok ? '✓' : '–'), el('b', {}, name), el('span', { class: 'muted' }, note));
    const canWork = st.done.ws && st.done.claude;
    return {
      title: t(canWork ? 'wz.done.title' : 'wz.done.almost'),
      body: [
        row(st.done.ws, t('wz.step.ws'), st.ws),
        row(st.done.claude, 'Claude', st.done.claude ? t(st.claude.mode === 'api' ? 'claude.api' : 'claude.sub') : t('wz.done.noClaude')),
        row(st.done.blender, 'Blender', t(st.done.blender ? 'wz.done.blender' : 'wz.done.noBlender')),
        row(st.done.fal, t('wz.step.fal'), t(st.done.fal ? 'wz.done.fal' : 'wz.done.noFal')),
        el('p', { class: 'muted' }, t('wz.done.later')),
      ],
      primary: {
        text: t('wz.start'),
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
        el('img', { class: 'welcome-icon', src: brand, alt: '' }),
        el('div', { class: 'welcome-titles' },
          el('h1', { class: 'welcome-title' },
            el('span', { class: 'welcome-name' }, el('span', { class: 'name-3d' }, '3D'), 'Modelist'),
            el('span', { class: 'welcome-version' }, meta.version)),
          el('p', { class: 'welcome-sub' }, t('wz.sub'))),
        el('div', { class: 'welcome-lang' },
          langSelect(async (code) => { setLang(code); await api('/settings', { method: 'PATCH', body: { ui: { lang: code } } }); draw(); }))),
      el('div', { class: 'steps' }, ...STEPS.map((x, i) => el('button', {
        class: 'step' + (i === st.step ? ' on' : '') + (st.done[x.key] ? ' done' : '') + (st.skipped[x.key] && !st.done[x.key] ? ' skip' : ''),
        disabled: locked(i) || st.busy,
        onclick: () => go(i),
      }, el('span', { class: 'step-n' }, st.done[x.key] ? '✓' : i + 1), t(x.title), x.optional && el('span', { class: 'step-opt' }, t('wz.optional'))))),
      el('div', { class: 'welcome-body' }, el('h2', {}, view.title), ...view.body),
      el('div', { class: 'welcome-foot' },
        st.step > 0 && st.step < 4 ? el('button', { class: 'btn ghost', disabled: st.busy, onclick: () => go(st.step - 1) }, '← ' + t('common.back')) : el('span'),
        el('div', { class: 'row' },
          view.secondary ? el('button', { class: 'btn ghost', disabled: st.busy, onclick: view.secondary.onclick }, view.secondary.text) : null,
          el('button', { class: 'btn primary', disabled: st.busy, onclick: view.primary.onclick }, st.busy ? t('common.wait') : view.primary.text)))));
  }

  function close() {
    back.remove();
    onDone?.();
  }

  draw();
}
