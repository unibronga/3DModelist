// 3DModelist — страница. Состояние живёт на сервере (рабочая папка и
// настройки), страница его опрашивает и показывает; своего хранилища у неё нет.

import { Viewer } from './viewer.js';
import { $, el, esc, fileUrl, base, money, api, toast, segment, errText } from './ui.js';
import { t, num, applyDOM, onLangChange, setLang } from './i18n.js';
import { applyTheme, applyScale, onScaleChange, getScale, getTheme } from './prefs.js';
import { openSettings, refreshHealth, blockers, setOnChange, H } from './settings.js';
import { openWelcome } from './welcome.js';
import { splitSheet } from './sheet.js';
import { MenuBar } from './menubar.js';
import { openHelp, openAbout, REPO } from './help.js';

// Короткий markdown агента: абзацы, списки, **жирный**, `код`, пути проекта — ссылками.
function md(src) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(?<![\w/])((?:refs|renders|out|models)\/[^\s<>"'`)]+\.(?:png|jpe?g|webp|md|glb|gltf|fbx|obj))/g,
      '<a href="#" data-file="$1">$1</a>');
  const out = [];
  let list = null;
  for (const raw of String(src).split('\n')) {
    const line = raw.trimEnd();
    const li = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      if (!list) { list = []; out.push(list); }
      list.push(inline(li[1]));
      continue;
    }
    list = null;
    if (!line.trim()) { out.push(''); continue; }
    out.push(inline(line.replace(/^#+\s*/, '')));
  }
  let html = '';
  let para = [];
  const flush = () => { if (para.length) html += `<p>${para.join('<br>')}</p>`; para = []; };
  for (const b of out) {
    if (Array.isArray(b)) { flush(); html += '<ul>' + b.map((x) => `<li>${x}</li>`).join('') + '</ul>'; }
    else if (b === '') flush();
    else para.push(b);
  }
  flush();
  return html;
}

// ── состояние ─────────────────────────────────────────────────────────────
const S = {
  meta: null,
  tasks: [],
  library: [],
  refsTree: null,
  sel: null,              // id выбранной задачи; null — форма новой модели
  task: null,
  events: [],
  eventsTotal: 0,
  openGroups: new Set(),
  shown: null,            // путь модели в окне
  autoFollow: true,       // сам переключаться на новую модель задачи
  framesKey: '',
  draft: freshDraft(),
};

function freshDraft() {
  return {
    name: '', brief: '', route: 'script', uploads: [], refPaths: [],
    agent: { model: 'opus', effort: 'high', critic: 'opus' },
    gen: { model: 'tripo3d/p2/image-to-3d', texture: false, detail: null },
  };
}

// ── просмотр ──────────────────────────────────────────────────────────────
const viewer = new Viewer($('#viewport'));
let modelInfo = null;
function renderModelInfo() {
  const i = modelInfo;
  $('#model-info').textContent = i
    ? t('viewer.info', { size: i.size.map((v) => v.toFixed(2)).join(' × '), tris: num(i.tris), ext: i.ext.toUpperCase() })
    : '';
}
viewer.onInfo = (i) => { modelInfo = i; renderModelInfo(); };
onScaleChange((k) => viewer.setScale(k));
viewer.setScale(getScale());

async function showModel(rel, { manual = false } = {}) {
  if (manual) S.autoFollow = false;
  if (S.shown === rel && viewer.root) return;
  S.shown = rel;
  $('#empty').hidden = true;
  const busy = el('div', { class: 'loading' }, t('viewer.loading', { name: base(rel) }));
  $('#viewport').append(busy);
  try {
    await viewer.load(fileUrl(rel));
  } catch (e) {
    toast(t('viewer.fail', { msg: e.message }), true);
    S.shown = null;
  } finally {
    busy.remove();
  }
  renderOutputs();
  renderLibrary();
}

// Режим вида и грани — одни функции для кнопок, меню и клавиш.
function setViewMode(mode) {
  document.querySelectorAll('#view-mode button').forEach((x) => x.classList.toggle('on', x.dataset.mode === mode));
  viewer.setMode(mode);
}
function toggleFlat() {
  const on = !$('#flat').classList.contains('on');
  $('#flat').classList.toggle('on', on);
  viewer.setFlat(on);
}
document.querySelectorAll('#view-mode button').forEach((b) => b.addEventListener('click', () => setViewMode(b.dataset.mode)));
$('#flat').addEventListener('click', toggleFlat);
$('#fit').addEventListener('click', () => viewer.fit());

// ── просмотр кадров и спеки ───────────────────────────────────────────────
function openImages(list, i) {
  const lb = $('#lightbox');
  const draw = () => {
    lb.replaceChildren(el('div', {},
      el('img', { src: fileUrl(list[i]) }),
      el('div', { class: 'cap' }, `${list[i]}  ·  ${i + 1} / ${list.length}  ·  ${t('lightbox.keys')}`)));
  };
  const key = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowRight') { i = (i + 1) % list.length; draw(); }
    if (e.key === 'ArrowLeft') { i = (i - 1 + list.length) % list.length; draw(); }
  };
  const close = () => { lb.hidden = true; document.removeEventListener('keydown', key); };
  lb.onclick = (e) => { if (e.target === lb || e.target.tagName === 'IMG') close(); };
  document.addEventListener('keydown', key);
  draw();
  lb.hidden = false;
}

async function openDoc(rel) {
  const lb = $('#lightbox');
  const text = await fetch(fileUrl(rel)).then((r) => r.text());
  lb.replaceChildren(el('div', { class: 'doc' }, el('div', { class: 'muted' }, rel), '\n', text));
  lb.onclick = (e) => { if (e.target === lb) lb.hidden = true; };
  lb.hidden = false;
}

function openFile(rel) {
  if (/\.(png|jpe?g|webp)$/i.test(rel)) openImages([rel], 0);
  else if (/\.md$/i.test(rel)) openDoc(rel);
  else showModel(rel, { manual: true });
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-file]');
  if (!a) return;
  e.preventDefault();
  openFile(a.dataset.file);
});

// ── левая колонка ─────────────────────────────────────────────────────────
function taskBadge(tk) {
  if (tk.agent_state === 'running') return el('span', { class: 'badge run' }, t('badge.running'));
  if (tk.gen_state === 'queued' || tk.gen_state === 'running') return el('span', { class: 'badge run' }, t('badge.generating'));
  if (tk.state === 'done') return el('span', { class: 'badge done' }, t('badge.done'));
  if (tk.gen_state === 'error') return el('span', { class: 'badge err' }, t('badge.error'));
  if (tk.agent_state === 'waiting') return el('span', { class: 'badge wait' }, t('badge.waiting'));
  return el('span', { class: 'badge' }, t('badge.new'));
}

const routeName = (r) => t(r === 'generator' ? 'route.generator.short' : 'route.script.short');

function renderTasks() {
  const box = $('#tasks');
  box.replaceChildren(...(S.tasks.length ? S.tasks.map((tk) => el('button', {
    class: 'item' + (S.sel === tk.id ? ' sel' : ''),
    onclick: () => selectTask(tk.id),
  },
  el('div', { class: 'body' },
    el('div', { class: 't' }, tk.name),
    el('div', { class: 's' }, routeName(tk.route) + (tk.spent_usd ? ' · ' + money(tk.spent_usd) : ''))),
  taskBadge(tk))) : [el('div', { class: 'none' }, t('side.noTasks'))]));
}

function renderLibrary() {
  const box = $('#library');
  box.replaceChildren(...(S.library.length ? S.library.map((m) => {
    const main = m.files.find((f) => /\.glb$/i.test(f.path) && !f.path.includes('/gen_')) || m.files[0];
    const active = m.files.some((f) => f.path === S.shown);
    return el('button', {
      class: 'item' + (active ? ' sel' : ''),
      title: m.files.map((f) => f.path).join('\n'),
      onclick: () => showModel(main.path, { manual: true }),
    },
    el('div', { class: 'thumb', style: m.preview ? `background-image:url("${fileUrl(m.preview)}")` : '' }),
    el('div', { class: 'body' },
      el('div', { class: 't' }, m.name),
      el('div', { class: 's' }, t('lib.files', { n: m.files.length }) + (m.blend ? ' · .blend' : ''))));
  }) : [el('div', { class: 'none' }, t('side.noModels'))]));
}

async function renderBlender() {
  const b = $('#blender');
  try {
    const v = await api('/blender');
    const found = H.health?.blender?.bin !== false;
    // Закрытый Blender — не беда: студия поднимет его сама, когда агент возьмётся за работу.
    b.className = 'blender ' + (v.online ? 'on' : found ? 'idle' : 'off');
    b.querySelector('.txt').textContent = v.online
      ? `Blender · ${v.file || t(v.background ? 'blender.headless' : 'blender.noFile')}`
      : t(found ? 'blender.auto' : 'blender.missing');
    b.title = v.online ? `Blender ${v.version || ''}${v.background ? ' — ' + t('blender.headlessHint') : ''}\n${v.file || ''}`
      : t(found ? 'blender.autoHint' : 'blender.missingHint');
  } catch { /* сервер перезапускается */ }
}

// ── агенты: моделист, глубина, критик ─────────────────────────────────────
const FAMILY_NAME = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const familyOf = (id) => Object.keys(FAMILY_NAME).find((f) => String(id).includes(f)) || null;

// Список моделей: «всегда последняя» по семействам, затем версии, затем своя.
function modelSelect(value, { critic = false, onChange }) {
  const fams = Object.keys(FAMILY_NAME).filter((f) => critic || f !== 'haiku');
  const versions = (S.meta.models || []).filter((m) => critic || m.modeler);
  const known = new Set([...fams, ...versions.map((m) => m.id), 'off']);
  const sel = el('select', {
    class: 'select',
    onchange: (e) => {
      let v = e.target.value;
      if (v === '__custom') {
        v = (prompt(t('model.customPrompt'), '') || '').trim();
        if (!/^[a-z0-9][a-z0-9.\-]{1,63}$/.test(v) || (!critic && familyOf(v) === 'haiku')) {
          if (v) toast(t('model.customBad'), true);
          e.target.value = value;
          return;
        }
      }
      onChange(v);
    },
  },
  el('optgroup', { label: t('model.latestGroup') }, ...fams.map((f) => el('option', { value: f }, t('model.latest', { name: FAMILY_NAME[f] })))),
  el('optgroup', { label: t('model.versionsGroup') }, ...versions.map((m) => el('option', { value: m.id }, m.label))),
  !known.has(value) && el('option', { value }, value),
  el('option', { value: '__custom' }, t('model.custom')),
  critic && el('option', { value: 'off' }, t('model.noCritic')));
  sel.value = value;
  return sel;
}

function modelNote(id) {
  const f = familyOf(id);
  return f ? t('model.note.' + f) : t('model.note.custom');
}

function agentBlock(agent, onChange, what) {
  const billing = H.health?.claude?.mode === 'api' ? t('billing.api') : t('billing.sub');
  return el('div', { class: 'card' },
    el('div', { class: 'card-h' }, t('agents.title'), el('span', { class: 'badge' }, billing)),
    what && el('div', { class: 'muted' }, what),
    el('div', { class: 'agent-row' },
      el('span', { class: 'muted' }, t('agents.modeler')),
      el('div', {}, modelSelect(agent.model, { onChange: (v) => onChange({ model: v }) }),
        el('div', { class: 'note' }, modelNote(agent.model)))),
    el('div', { class: 'agent-row' },
      el('span', { class: 'muted' }, t('agents.effort')),
      segment([
        ['medium', t('effort.medium'), t('effort.medium.hint')],
        ['high', t('effort.high'), t('effort.high.hint')],
        ['max', t('effort.max'), t('effort.max.hint')],
      ], agent.effort, (v) => onChange({ effort: v }), 'full')),
    el('div', { class: 'agent-row' },
      el('span', { class: 'muted' }, t('agents.critic')),
      modelSelect(agent.critic, { critic: true, onChange: (v) => onChange({ critic: v }) })));
}

// ── правая панель: новая модель ───────────────────────────────────────────
function genMeta(id) { return S.meta.generators.find((g) => g.id === id); }
function genPrice(d) {
  const g = genMeta(d.gen.model);
  return g ? (d.gen.texture ? g.priceTex : g.price) : 0;
}
const genTag = (g) => t('gen.tag.' + g.label.split(' ')[0].toLowerCase());

function readFiles(files) {
  for (const f of files) {
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast(t('form.badImage'), true); continue; }
    const rd = new FileReader();
    rd.onload = () => {
      S.draft.uploads.push({ name: f.name, data: rd.result });
      if (!S.draft.name) S.draft.name = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      renderPanel();
    };
    rd.readAsDataURL(f);
  }
}

function genBlock(g, onChange) {
  const meta = genMeta(g.model);
  const detail = meta?.detail;
  const val = g.detail ?? detail?.def;
  const unit = (v) => t('gen.unit.' + detail.unit, { n: num(v) });
  return el('div', { class: 'field' },
    el('div', { class: 'label' }, t('gen.title'), el('span', { class: 'hint' }, t('gen.paid'))),
    el('div', { class: 'gens' }, ...S.meta.generators.map((x) => el('button', {
      class: 'gen' + (x.id === g.model ? ' on' : ''),
      onclick: () => onChange({ model: x.id, detail: null }),
    },
    el('div', {}, el('div', { class: 'gl' }, x.label), el('div', { class: 'gt' }, genTag(x))),
    el('div', { class: 'gp' }, money(g.texture ? x.priceTex : x.price))))),
    el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: g.texture, onchange: (e) => onChange({ texture: e.target.checked }) }),
      el('span', {}, t('gen.texture'), el('div', { class: 'muted' }, t('gen.texture.hint')))),
    detail && el('div', { class: 'field' },
      el('div', { class: 'label' }, t('gen.detail'), el('span', { class: 'hint', id: 'detail-v' }, unit(val))),
      el('input', {
        class: 'range', type: 'range', min: detail.min, max: detail.max, step: detail.min, value: val,
        oninput: (e) => { g.detail = Number(e.target.value); $('#detail-v').textContent = unit(g.detail); },
      })));
}

// Картинки для генератора: миниатюры на выбор. sheetInfo — результат splitSheet
// для выбранной картинки (null — ещё считается).
function sourcePicker({ items, selected, onPick, sheetInfo, onSplit, splitting }) {
  const n = sheetInfo?.views?.length || 0;
  return el('div', { class: 'field' },
    el('div', { class: 'label' }, t('gen.source')),
    el('div', { class: 'refs pick' }, ...items.map((it, i) => el('div', {
      class: 'ref' + (i === selected ? ' on' : ''), style: `background-image:url("${it.src}")`, title: it.title,
      onclick: () => onPick(i),
    }, it.badge && el('span', { class: 'ref-badge' }, it.badge)))),
    n >= 2 && el('div', { class: 'notice' },
      el('div', {}, t('gen.sheet', { n })),
      !onSplit && el('div', {}, t('gen.sheet.pickView')),
      onSplit && el('button', { class: 'btn primary', disabled: splitting, onclick: onSplit }, splitting ? t('common.wait') : t('gen.sheet.split'))));
}

async function loadRefsTree() {
  if (!S.refsTree) S.refsTree = await api('/refs').catch(() => []);
  return S.refsTree;
}

function renderNewForm() {
  const d = S.draft;
  const panel = $('#panel');
  const refThumbs = [
    ...d.uploads.map((u, i) => el('div', { class: 'ref', style: `background-image:url("${u.data}")`, title: u.name },
      el('button', { title: t('form.remove'), onclick: (e) => { e.stopPropagation(); d.uploads.splice(i, 1); renderPanel(); } }, '×'))),
    ...d.refPaths.map((p, i) => el('div', { class: 'ref', style: `background-image:url("${fileUrl(p)}")`, title: p, onclick: () => openImages(d.refPaths, i) },
      el('button', { title: t('form.remove'), onclick: (e) => { e.stopPropagation(); d.refPaths.splice(i, 1); renderPanel(); } }, '×'))),
  ];

  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true, onchange: (e) => readFiles(e.target.files) });
  const drop = el('div', {
    class: 'drop',
    onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); readFiles(e.dataTransfer.files); },
  },
  el('div', { class: 'big' }, t('form.drop')),
  el('div', { class: 'small' }, t('form.drop.hint')));

  const pick = el('select', { class: 'select', onchange: (e) => { if (e.target.value && !d.refPaths.includes(e.target.value)) d.refPaths.push(e.target.value); renderPanel(); } },
    el('option', { value: '' }, t('form.fromRefs')));
  loadRefsTree().then((list) => {
    const groups = {};
    for (const p of list) (groups[p.split('/').slice(0, -1).join('/')] ||= []).push(p);
    for (const [g, items] of Object.entries(groups)) {
      pick.append(el('optgroup', { label: g }, ...items.map((p) => el('option', { value: p }, base(p)))));
    }
  });

  const isGen = d.route === 'generator';
  const price = isGen ? genPrice(d) : 0;
  const hasRef = d.uploads.length + d.refPaths.length > 0;

  const todo = blockers();
  if (!isGen && H.health?.blender?.bin === false) todo.push(t('block.blenderForScript'));
  const start = el('button', {
    class: 'btn big wide ' + (isGen ? 'accent' : 'primary'),
    disabled: !hasRef || !d.name.trim() || todo.length > 0,
    onclick: () => createAndStart(start),
  }, isGen ? t('form.generate', { price: money(price) }) : t('form.start'));

  panel.replaceChildren(
    el('div', { class: 'panel-head' },
      el('div', { class: 'panel-title' }, t('form.title')),
      el('div', { class: 'panel-sub' }, t('form.sub'))),
    el('div', { class: 'panel-scroll' },
      todo.length > 0 && el('div', { class: 'notice' },
        el('b', {}, t('form.setupFirst')),
        el('div', {}, todo.join(' · ')),
        el('button', { class: 'btn primary', onclick: () => openSettings() }, t('form.openSettings'))),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, t('form.ref'), el('span', { class: 'req' }, t('form.required'))),
        drop, input, el('div', { class: 'refs' }, ...refThumbs), pick),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, t('form.name')),
        el('input', { class: 'input', value: d.name, placeholder: t('form.name.ph'), oninput: (e) => { d.name = e.target.value; start.disabled = !hasRef || !d.name.trim() || todo.length > 0; } })),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, t('form.brief'), el('span', { class: 'hint' }, t('form.optional'))),
        el('textarea', { class: 'textarea', placeholder: t('form.brief.ph'), oninput: (e) => { d.brief = e.target.value; } }, d.brief)),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, t('form.route')),
        segment([
          ['script', t('route.script'), t('route.script.hint')],
          ['generator', t('route.generator'), t('route.generator.hint')],
        ], d.route, (v) => { d.route = v; renderPanel(); }, 'full')),
      isGen ? formSource(d) : null,
      isGen ? genBlock(d.gen, (p) => { Object.assign(d.gen, p); renderPanel(); }) : null,
      agentBlock(d.agent, (p) => { Object.assign(d.agent, p); renderPanel(); }, t(isGen ? 'agents.afterGen' : 'agents.build')),
    ),
    el('div', { class: 'panel-foot' },
      el('div', { class: 'cost' }, t('agents.title'), el('b', {}, H.health?.claude?.mode === 'api' ? t('billing.api') : t('billing.sub'))),
      isGen && el('div', { class: 'cost' }, t('form.genCost'), el('b', {}, money(price))),
      start),
  );
}

// Первая картинка заказа — лист? Тогда режем на виды прямо в форме:
// генератору уйдёт выбранный вид, агенту — и лист, и все виды.
function formSource(d) {
  const src = d.uploads[0]?.data || (d.refPaths[0] && fileUrl(d.refPaths[0]));
  if (!src) return null;
  if (S.formSheet?.src !== src) {
    S.formSheet = { src, info: null };
    splitSheet(src).then((info) => { if (S.formSheet?.src === src) { S.formSheet.info = info; d.gen.view = 0; renderPanel(); } }, () => {});
    return null;
  }
  const views = S.formSheet.info?.views || [];
  if (views.length < 2) return null;
  const pick = Math.min(d.gen.view || 0, views.length - 1);
  return el('div', { class: 'field' },
    el('div', { class: 'label' }, t('gen.source')),
    el('div', { class: 'muted' }, t('gen.sheet.auto', { n: views.length })),
    el('div', { class: 'refs pick' }, ...views.map((v, i) => el('div', {
      class: 'ref' + (i === pick ? ' on' : ''), style: `background-image:url("${v}")`, title: t('gen.view', { n: i + 1 }),
      onclick: () => { d.gen.view = i; renderPanel(); },
    }, el('span', { class: 'ref-badge' }, t('gen.view', { n: i + 1 }))))));
}

document.addEventListener('paste', (e) => {
  if (S.sel || !e.clipboardData) return;
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); readFiles(files); }
});

async function createAndStart(btn) {
  const d = S.draft;
  const isGen = d.route === 'generator';
  if (isGen) {
    const g = genMeta(d.gen.model);
    if (!confirm(t('gen.confirm', { name: g.label, price: money(genPrice(d)) }))) return;
  }
  btn.disabled = true;
  btn.textContent = t('form.creating');
  try {
    // Лист персонажа: виды кладём в референсы рядом с листом.
    const views = isGen && S.formSheet?.info?.views?.length >= 2 ? S.formSheet.info.views : [];
    const uploads = [...d.uploads, ...views.map((data, i) => ({ name: `view_${i + 1}.png`, data }))];
    const task = await api('/tasks', {
      method: 'POST',
      body: { name: d.name, brief: d.brief, route: d.route, uploads, refPaths: d.refPaths, agent: d.agent },
    });
    if (isGen) {
      const k = (d.gen.view || 0) + 1;
      const ref = views.length ? task.refs.find((r) => new RegExp(`/view_${k}\\.png$`).test(r)) : undefined;
      await api(`/tasks/${task.id}/generate`, { method: 'POST', body: { ...d.gen, ref } });
    }
    else await api(`/tasks/${task.id}/agent`, { method: 'POST', body: {} });
    S.draft = freshDraft();
    S.formSheet = null;
    S.refsTree = null;
    await refreshTasks();
    await selectTask(task.id);
  } catch (e) {
    toast(errText(e), true);
    btn.disabled = false;
    btn.textContent = t('form.retry');
  }
}

// ── процесс в центре: что происходит прямо сейчас ─────────────────────────
// Пока идёт генерация или ход агента, человек должен видеть шаги, время и
// что делается сейчас — а не пустое окно (претензия владельца 27.09).
const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

function stepRow(steps) {
  return el('div', { class: 'proc-steps' }, ...steps.map(([label, state]) => el('div', { class: 'proc-step ' + state },
    el('span', { class: 'proc-mark' }, state === 'done' ? '✓' : state === 'skip' ? '–' : ''), label)));
}

function renderProcess() {
  const box = $('#process');
  const tk = S.task;
  const g = tk?.gen;
  const now = Date.now() / 1000;
  const genActive = g && ['queued', 'running', 'downloading'].includes(g.state);
  const agentActive = !!tk?.running;
  if (!tk || (!genActive && !agentActive)) {
    box.hidden = true;
    $('#empty').hidden = !!S.shown;
    return;
  }
  box.hidden = false;
  $('#empty').hidden = true;
  box.classList.toggle('compact', !!S.shown);       // модель уже в окне — карточка сверху, не поверх

  if (genActive) {
    const typical = g.typical || 90;
    const pct = g.state === 'queued' ? 4
      : g.state === 'running' ? Math.min(94, 6 + ((now - (g.running_at || g.started_at)) / typical) * 88) : 97;
    const st = (i) => {
      const order = { queued: 1, running: 2, downloading: 3 }[g.state];
      return i < order ? 'done' : i === order ? 'active' : 'wait';
    };
    box.replaceChildren(
      el('div', { class: 'proc-head' },
        el('span', { class: 'spinner' }),
        el('div', {},
          el('div', { class: 'proc-title' }, t('proc.gen.title', { name: g.label })),
          el('div', { class: 'proc-sub' }, t('proc.gen.typical', { n: Math.max(1, Math.round(typical / 60)) }))),
        el('div', { class: 'proc-time' }, clock(now - g.started_at))),
      el('div', { class: 'bar' }, el('div', { class: 'bar-fill', style: `width:${pct.toFixed(1)}%` })),
      stepRow([
        [t('proc.step.sent'), 'done'],
        [g.queue_position ? t('proc.step.queuePos', { n: g.queue_position }) : t('proc.step.queue'), st(1)],
        [t('proc.step.run'), st(2)],
        [t('proc.step.download'), st(3)],
        [t('proc.step.done'), 'wait'],
      ]),
      el('div', { class: 'proc-note' }, t('proc.gen.note')));
    return;
  }

  // Ход агента: этап с табло, последнее действие, время хода.
  const rows = tk.pipe?.stages || [];
  const cur = rows.find((r) => r.state === 'running');
  let action = '';
  for (let i = S.events.length - 1; i >= 0; i--) {
    const ev = S.events[i];
    if (ev.kind === 'tool') { action = toolText(ev); break; }
    if (ev.kind === 'text') { action = ev.text.split('\n')[0].slice(0, 120); break; }
    if (ev.kind === 'user' || ev.key === 'ev.agentStarted') break;
  }
  const since = tk.turn_started_at || now;
  box.replaceChildren(
    el('div', { class: 'proc-head' },
      el('span', { class: 'spinner' }),
      el('div', {},
        el('div', { class: 'proc-title' }, cur ? t('proc.agent.stage', { stage: t('stage.' + cur.n + '.title') }) : t('proc.agent.title')),
        el('div', { class: 'proc-sub' }, action ? t('proc.agent.action', { action }) : t('proc.agent.starting'))),
      el('div', { class: 'proc-time' }, clock(now - since))),
    el('div', { class: 'bar indet' }, el('div', { class: 'bar-fill' })),
    stepRow(S.meta.stages.map((s) => {
      const r = rows.find((x) => x.n === s.n);
      const state = !r ? 'wait' : r.state === 'done' ? 'done' : r.state === 'skipped' ? 'skip' : r.state === 'running' ? 'active' : 'wait';
      return [t('stage.' + s.n), state];
    })),
    el('div', { class: 'proc-note' }, t('proc.agent.note')));
}
setInterval(() => { try { renderProcess(); } catch { /* до загрузки */ } }, 1000);

// ── правая панель: задача ─────────────────────────────────────────────────
function renderTaskPanel() {
  const tk = S.task;
  const panel = $('#panel');
  const running = tk.running;
  const started = !!tk.agent?.session_id;

  const sub = [t('task.folder', { slug: tk.slug }), routeName(tk.route), t('task.spent', { sum: money(tk.spent_usd) })];
  if (tk.limit5h != null) sub.push(t('task.limit', { p: Math.round(tk.limit5h * 100) }));
  const head = el('div', { class: 'panel-head' },
    el('div', { class: 'row between' },
      el('div', { class: 'panel-title' }, tk.name),
      tk.state === 'done'
        ? el('button', { class: 'btn ghost', onclick: () => patch({ state: 'open' }) }, t('task.reopen'))
        : el('button', { class: 'btn ghost', title: t('task.done.hint'), onclick: () => patch({ state: 'done' }) }, '✓ ' + t('task.done'))),
    el('div', { class: 'panel-sub' }, sub.join(' · ')));

  const refs = el('div', { class: 'refs' }, ...(tk.refs || []).map((p, i) => el('div', {
    class: 'ref', style: `background-image:url("${fileUrl(p)}")`, title: p, onclick: () => openImages(tk.refs, i),
  })));

  const blocks = [refs];
  if (tk.media?.spec) blocks.push(el('button', { class: 'btn wide', onclick: () => openDoc(tk.media.spec) }, t('task.openSpec')));
  // Тот же выбор, что в форме: кто строит форму. Сменить можно и потом.
  blocks.push(el('div', { class: 'field' },
    el('div', { class: 'label' }, t('form.route')),
    segment([
      ['script', t('route.script'), t('route.script.hint')],
      ['generator', t('route.generator'), t('route.generator.hint')],
    ], tk.route, (v) => { if (!running && v !== tk.route) patch({ route: v }); }, 'full')));
  if (tk.route === 'generator') blocks.push(genCard(tk));
  blocks.push(agentBlock(tk.agent, (p) => patch({ agent: { ...tk.agent, ...p } }),
    t(tk.route === 'generator' ? 'agents.afterGen' : 'agents.build')));
  blocks.push(el('div', { class: 'feed', id: 'feed' }));

  const ta = el('textarea', {
    class: 'textarea', id: 'msg',
    placeholder: started ? t('chat.ph') : t('chat.ph.first'),
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); },
  });
  const send = async (text) => {
    const msg = text ?? ta.value.trim();
    if (started && !msg) return;
    try {
      await api(`/tasks/${tk.id}/agent`, { method: 'POST', body: { message: msg } });
      ta.value = '';
      await refreshTask();
    } catch (e) { toast(errText(e), true); }
  };

  const genReady = tk.route !== 'generator' || tk.gen?.state === 'done';
  // Быстрые ответы уходят агенту на языке интерфейса — на нём же он и ответит.
  const foot = el('div', { class: 'panel-foot composer' },
    running
      ? el('div', { class: 'row between' },
        el('div', { class: 'typing' }, t('chat.working')),
        el('button', { class: 'btn danger', onclick: () => api(`/tasks/${tk.id}/stop`, { method: 'POST' }).then(refreshTask) }, t('chat.stop')))
      : null,
    !running && started && el('div', { class: 'quick' },
      el('button', { class: 'btn', onclick: () => send(t('quick.ok.msg')) }, t('quick.ok')),
      el('button', { class: 'btn', onclick: () => send(t('quick.go.msg')) }, t('quick.go')),
      el('button', { class: 'btn', onclick: () => send(t('quick.show.msg')) }, t('quick.show'))),
    !running && ta,
    !running && (started
      ? el('button', { class: 'btn primary', onclick: () => send() }, t('chat.send'))
      : el('button', { class: 'btn primary big', disabled: !genReady, onclick: () => send(ta.value.trim()) },
        tk.route === 'generator' ? t('chat.handOver') : t('chat.startAgent'))),
  );

  panel.replaceChildren(head, el('div', { class: 'panel-scroll', id: 'task-scroll' }, ...blocks), foot);
  renderFeed(true);
}

function genCard(tk) {
  const g = tk.gen;
  const st = g?.state;
  const badge = {
    queued: ['run', t('gen.queued')], running: ['run', t('gen.running')], done: ['done', t('badge.done')], error: ['err', t('badge.error')],
  }[st] || ['', t('gen.notRun')];
  const d = S.genDraft ||= { model: 'tripo3d/p2/image-to-3d', texture: false, detail: null, ref: null };
  const busy = ['queued', 'running', 'downloading'].includes(st);
  // Картинка для генератора: выбранная; иначе — первый вырезанный вид; иначе — первый референс.
  const refs = tk.refs || [];
  const cur = refs.includes(d.ref) ? d.ref : refs.find((r) => /\/view_\d+\.png$/.test(r)) || refs[0];
  const curSrc = cur && fileUrl(cur);
  if (curSrc && S.sheetFor !== curSrc) {
    S.sheetFor = curSrc;
    S.sheetInfo = null;
    splitSheet(curSrc).then((info) => { if (S.sheetFor === curSrc) { S.sheetInfo = info; renderTaskPanel(); } }, () => {});
  }
  const sheetN = S.sheetFor === curSrc ? S.sheetInfo?.views?.length || 0 : 0;
  const price = (() => { const m = genMeta(d.model); return m ? (d.texture ? m.priceTex : m.price) : 0; })();
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-h' }, g?.label || t('gen.title'), el('span', { class: 'badge ' + badge[0] }, badge[1])),
    st === 'error' && el('div', { class: 'ev error' }, g.errorCode ? errText({ code: g.errorCode }) : g.error),
    g?.files?.length > 0 && el('div', { class: 'muted' }, t('gen.files') + ' ', ...g.files.filter((f) => /\.(glb|fbx|obj)$/i.test(f))
      .map((f) => el('a', { href: '#', 'data-file': f, style: 'margin-right:8px' }, base(f)))),
  );
  if (!busy) {
    const box = el('div', {});
    const split = async () => {
      S.splitting = true; renderTaskPanel();
      try {
        const info = await splitSheet(curSrc);
        const r = await api(`/tasks/${tk.id}/refs`, { method: 'POST', body: { uploads: info.views.map((data, i) => ({ name: `view_${i + 1}.png`, data })) } });
        d.ref = r.added[0];
        await refreshTask(true);
      } catch (e) { toast(errText(e), true); }
      S.splitting = false; renderTaskPanel();
    };
    const draw = () => box.replaceChildren(
      sourcePicker({
        items: refs.map((r) => ({ src: fileUrl(r), title: r, badge: (/\/view_(\d+)\.png$/.exec(r) || [])[1] && t('gen.view', { n: /\/view_(\d+)\.png$/.exec(r)[1] }) })),
        selected: refs.indexOf(cur),
        onPick: (i) => { d.ref = refs[i]; renderTaskPanel(); },
        sheetInfo: S.sheetFor === curSrc ? S.sheetInfo : null,
        onSplit: refs.some((r) => /\/view_\d+\.png$/.test(r)) ? null : split,   // уже разрезан — просто выбрать вид
        splitting: S.splitting,
      }),
      genBlock(d, (p) => { Object.assign(d, p); draw(); }),
      el('button', {
        class: 'btn accent wide', style: 'margin-top:10px',
        disabled: sheetN >= 2,                  // с листа генератор слепит несколько фигур
        title: sheetN >= 2 ? t('gen.sheet.blocked', { n: sheetN }) : '',
        onclick: async () => {
          const m = genMeta(d.model);
          if (!confirm(t('gen.confirm', { name: m.label, price: money(price) }))) return;
          try { await api(`/tasks/${tk.id}/generate`, { method: 'POST', body: { ...d, ref: cur } }); await refreshTask(); } catch (e) { toast(errText(e), true); }
        },
      }, t(st === 'done' ? 'gen.again' : 'gen.run', { price: money(price) })));
    draw();
    // Выбор картинки и генератора — виден сразу: спрятанный за кнопкой, он
    // терялся (владелец 27.09: «почему нет выбора модели?»).
    card.append(box);
  }
  return card;
}

// Строка события: ключ — перевод студии, text — как есть (агент, человек, Claude).
const evText = (ev) => (ev.key ? t(ev.key, ev.params) : ev.text || '');
const toolText = (ev) => (ev.verb ? (ev.verb === 'bash' || ev.verb === 'other' ? ev.arg : t('tool.' + ev.verb, { arg: ev.arg })) : ev.text || '');

// Лента: подряд идущие действия агента сворачиваются в одну строку.
function renderFeed(force = false) {
  const feed = $('#feed');
  if (!feed) return;
  const scroller = $('#task-scroll');
  const atBottom = force || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;

  const nodes = [];
  let group = null;
  S.events.forEach((ev, i) => {
    if (ev.kind === 'tool') {
      if (!group) { group = { start: i, items: [] }; nodes.push(group); }
      group.items.push(toolText(ev));
      return;
    }
    group = null;
    nodes.push(ev);
  });
  feed.replaceChildren(...nodes.map((n) => {
    if (n.items) {
      const det = el('details', { class: 'tools', open: S.openGroups.has(n.start) },
        el('summary', {}, `${t('tool.count', { n: n.items.length })}: ${n.items[n.items.length - 1]}`),
        ...n.items.map((x) => el('div', { class: 'tl', title: x }, x)));
      det.addEventListener('toggle', () => (det.open ? S.openGroups.add(n.start) : S.openGroups.delete(n.start)));
      return det;
    }
    switch (n.kind) {
      case 'text': return el('div', { class: 'ev text', html: md(n.text) });
      case 'user': return el('div', { class: 'ev user' }, n.text);
      case 'result': return el('div', { class: 'ev result' + (n.error ? ' err' : '') }, evText(n));
      case 'error': return el('div', { class: 'ev error' }, evText(n));
      case 'gen': return el('div', { class: 'ev gen' }, evText(n));
      default: return el('div', { class: 'ev sys' }, evText(n));
    }
  }));
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

async function patch(body) {
  try {
    S.task = await api(`/tasks/${S.sel}`, { method: 'PATCH', body });
    renderTaskPanel();
    refreshTasks();
  } catch (e) { toast(errText(e), true); }
}

function renderPanel() {
  if (S.sel && S.task) renderTaskPanel();
  else renderNewForm();
}

// ── низ: этапы, кадры, выдача ─────────────────────────────────────────────
function renderDock() {
  const tk = S.task;
  $('#dock').hidden = !tk;
  if (!tk) return;

  $('#frames').dataset.empty = t('dock.noFrames');
  const rows = tk.pipe?.stages || [];
  $('#stages').replaceChildren(...S.meta.stages.map((s) => {
    const r = rows.find((x) => x.n === s.n) || { state: 'pending', note: '' };
    const mark = { done: '✓', running: '▸', skipped: '–' }[r.state] || s.n;
    let time = '';
    if (r.started_at) {
      const end = r.finished_at || Date.now() / 1000;
      const sec = Math.max(0, Math.round(end - r.started_at));
      time = sec >= 60 ? t('time.min', { n: Math.floor(sec / 60) }) : t('time.sec', { n: sec });
    }
    return el('div', { class: `st ${r.state}${s.gate ? ' gate' : ''}`, title: r.note || t('stage.' + s.n + '.title') },
      el('div', { class: 'h', 'data-gate': t('stage.gate') }, el('span', { class: 'mark' }, mark), t('stage.' + s.n)),
      el('div', { class: 'n' }, r.note || (r.state === 'pending' ? t('stage.pending') : time)));
  }));

  const frames = tk.media?.frames || [];
  const key = frames.map((f) => f.path + f.mtime).join('|');
  if (key !== S.framesKey) {
    S.framesKey = key;
    const list = frames.map((f) => f.path);
    $('#frames').replaceChildren(...frames.map((f, i) => el('img', {
      src: fileUrl(f.path) + '?v=' + Math.round(f.mtime), title: f.path, loading: 'lazy',
      onclick: () => openImages(list, i),
    })));
  }
  renderOutputs();
}

function renderOutputs() {
  const tk = S.task;
  const box = $('#outputs');
  if (!tk) { box.replaceChildren(); return; }
  const items = (tk.media?.models || []).map((m) => el('span', {
    class: 'out' + (m.path === S.shown ? ' sel' : ''), title: m.path,
    onclick: (e) => { if (e.target.tagName !== 'A') showModel(m.path, { manual: true }); },
  }, base(m.path), el('a', { href: fileUrl(m.path, true), title: t('out.download') }, '↓')));
  if (tk.media?.blend) {
    items.push(el('span', { class: 'out', title: tk.media.blend }, base(tk.media.blend),
      el('a', { href: fileUrl(tk.media.blend, true), title: t('out.download') }, '↓')));
  }
  box.replaceChildren(...items);
}

// ── выбор и опрос ─────────────────────────────────────────────────────────
async function selectTask(id) {
  S.sel = id;
  S.task = null;
  S.events = [];
  S.eventsTotal = 0;
  S.openGroups = new Set();
  S.framesKey = '';
  S.autoFollow = true;
  S.genDraft = null;
  S.genOpen = false;
  renderTasks();
  if (!id) {
    renderPanel();
    renderDock();
    renderProcess();
    return;
  }
  await refreshTask(true);
}

let lastPanelKey = '';

async function refreshTask(first = false) {
  if (!S.sel) return;
  const id = S.sel;
  const [tk, ev] = await Promise.all([
    api(`/tasks/${id}`),
    api(`/tasks/${id}/events?after=${S.eventsTotal}`),
  ]);
  if (S.sel !== id) return;
  S.task = tk;
  const hadNew = ev.events.length > 0;
  S.events.push(...ev.events);
  S.eventsTotal = ev.total;

  // Панель перерисовываем целиком только когда поменялось её устройство —
  // иначе опрос сбрасывал бы набранный текст.
  const panelKey = JSON.stringify([tk.running, tk.agent, tk.state, tk.gen?.state, tk.gen?.files, tk.media?.spec, tk.spent_usd, tk.limit5h, tk.refs]);
  if (first || panelKey !== lastPanelKey) {
    const draft = $('#msg')?.value;
    lastPanelKey = panelKey;
    renderTaskPanel();
    if (draft && $('#msg')) $('#msg').value = draft;
  } else if (hadNew) {
    renderFeed();
  }
  renderDock();
  renderProcess();

  // Новая модель задачи — сразу в окно, пока человек сам ничего не выбрал.
  const newest = tk.media?.models?.[0]?.path;
  if (newest && S.autoFollow && newest !== S.shown) showModel(newest);
}

async function refreshTasks() {
  S.tasks = await api('/tasks');
  renderTasks();
}

async function refreshLibrary() {
  S.library = await api('/library');
  renderLibrary();
}

$('#new-task').addEventListener('click', () => selectTask(null));

// ── готовые модели: окно со всеми, открыть / показать в Finder / в Корзину ──
function openLibrary() {
  const back = el('div', { class: 'modal' });
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  const root = H.health?.workspace?.path || '';
  const draw = () => {
    const mainFile = (m) => m.files.find((f) => /\.glb$/i.test(f.path) && !f.path.includes('/gen_')) || m.files[0];
    const cards = S.library.map((m) => el('div', { class: 'lib-card' + (m.files.some((f) => f.path === S.shown) ? ' on' : '') },
      el('div', { class: 'lib-thumb', style: m.preview ? `background-image:url("${fileUrl(m.preview)}")` : '', onclick: () => { showModel(mainFile(m).path, { manual: true }); close(); } }),
      el('div', { class: 'lib-name' }, m.name),
      el('div', { class: 'muted' }, t('lib.files', { n: m.files.length }) + (m.blend ? ' · .blend' : '')),
      el('div', { class: 'lib-actions' },
        el('button', { class: 'btn primary', onclick: () => { showModel(mainFile(m).path, { manual: true }); close(); } }, t('lib.open')),
        host?.openPath && el('button', { class: 'btn ghost', onclick: () => reveal(`out/${m.name}`) }, t('lib.reveal')),
        el('button', {
          class: 'btn ghost danger',
          onclick: async () => {
            if (!confirm(t('lib.trash.confirm', { name: m.name }))) return;
            try {
              await api(`/library/${encodeURIComponent(m.name)}/trash`, { method: 'POST' });
              if (S.shown && S.shown.startsWith(`out/${m.name}/`)) { viewer.clear(); S.shown = null; $('#empty').hidden = false; }
              toast(t('lib.trashed', { name: m.name }));
              await refreshLibrary();
              draw();
            } catch (e) { toast(errText(e), true); }
          },
        }, t('lib.trash')))));
    back.replaceChildren(el('div', { class: 'sheet wide' },
      el('div', { class: 'sheet-head' },
        el('div', {}, el('div', { class: 'panel-title' }, t('side.library')),
          el('div', { class: 'panel-sub' }, t('lib.sub', { path: root + '/out' }))),
        el('button', { class: 'btn ghost', onclick: close }, t('common.close'))),
      el('div', { class: 'sheet-body' }, cards.length ? el('div', { class: 'lib-grid' }, ...cards) : el('p', { class: 'muted' }, t('side.noModels')))));
  };
  draw();
  document.body.append(back);
}
$('#lib-all').addEventListener('click', openLibrary);
$('#open-settings').addEventListener('click', () => openSettings());
$('#blender').addEventListener('click', () => { if (!$('#blender').classList.contains('on')) openSettings('blender'); });

// Плашка внизу слева: кто в Claude и сколько денег на fal.
let acct = null;
async function refreshAccount() {
  acct = await api('/account').catch(() => acct);
  renderAccount();
}
function renderAccount() {
  if (!acct) return;
  const c = acct.claude;
  let name;
  let plan = '';
  if (c.mode === 'api') { name = t('acct.api'); plan = c.tail ? '…' + c.tail : ''; }
  else if (!c.loggedIn) name = t('acct.notLogged');
  else { name = c.name || 'Claude'; plan = c.plan ? c.plan[0].toUpperCase() + c.plan.slice(1) : ''; }
  $('#acct-name').textContent = name;
  $('#acct-plan').textContent = plan ? '· ' + plan : '';
  $('#acct-avatar').textContent = (name.match(/\p{L}/gu) || ['?']).slice(0, 2).join('').toUpperCase();
  $('#acct-name').classList.toggle('warn', c.mode === 'subscription' && !c.loggedIn);

  // fal — одной строкой, просто остаток (просьба владельца).
  const f = acct.fal;
  const line = $('#acct-fal');
  line.className = 'acct-fal' + (f.balance != null ? '' : ' dim');
  line.textContent = !f.key ? t('acct.falNoKey')
    : f.balance != null ? t('acct.falBalance', { sum: money(f.balance) })
      : t('acct.falNoScope');
  line.title = f.scope === false ? t('fal.balanceHint') : '';
}

function renderHealth() {
  const todo = blockers();
  const b = $('#open-settings');
  b.classList.toggle('warn', todo.length > 0);
  b.title = todo.length ? t('settings.todo', { list: todo.join(', ') }) : t('settings.title');
}

// Всё, что нарисовано словами: после смены языка — перерисовать.
function renderAll() {
  applyDOM();
  if (!S.meta) return;              // язык сменили до загрузки каталога — остальное нарисует boot()
  renderHealth();
  renderTasks();
  renderLibrary();
  renderBlender();
  renderModelInfo();
  renderAccount();
  renderPanel();
  renderDock();
  renderProcess();
}
onLangChange(renderAll);

// После настроек: другая папка — другие задачи и модели; новый каталог моделей.
async function afterSettings() {
  refreshAccount();
  await refreshHealth().catch(() => {});
  S.meta = await api('/meta').catch(() => S.meta);
  renderHealth();
  await Promise.all([refreshTasks(), refreshLibrary(), renderBlender()]).catch(() => {});
  renderPanel();
}
setOnChange(afterSettings);

// Язык, тема и масштаб — из настроек сервера (общие для окна и браузера).
// Тема и масштаб первыми: язык перерисовывает страницу и не должен их задержать.
function applyUi(ui = {}) {
  applyTheme(ui.theme || 'system');
  applyScale(ui.scale || 1);
  if (ui.lang) setLang(ui.lang);
}

// ── строка меню, как в 3DPainter ──────────────────────────────────────────
const MOD = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';
const host = window.modelist || null;
async function saveUi(patch) {
  await api('/settings', { method: 'PATCH', body: { ui: patch } }).catch((e) => toast(errText(e), true));
}
function setThemeUi(v) { applyTheme(v); saveUi({ theme: v }); }
function setScaleUi(k) {
  const v = Math.round(Math.min(1.4, Math.max(0.8, k)) * 20) / 20;
  applyScale(v);
  saveUi({ scale: v });
}
// Папка внутри рабочей: в Finder — только из окна приложения.
function reveal(rel) {
  const root = H.health?.workspace?.path;
  if (!host?.openPath || !root) { toast(t('menu.appOnly'), true); return; }
  host.openPath(rel ? `${root}/${rel}` : root);
}
const taskFolder = () => (S.task ? (S.task.media?.models?.length ? `out/${S.task.slug}` : `refs/${S.task.slug}`) : null);
function download(rel) {
  const a = el('a', { href: fileUrl(rel, true), download: base(rel) });
  document.body.append(a); a.click(); a.remove();
}

const menuBar = new MenuBar($('#menubar'), [
  { title: () => t('menu.file'), items: [
    { label: () => t('side.new'), hint: MOD + 'N', action: () => selectTask(null) },
    { label: () => t('menu.openModel'), action: () => $('#open-model').click() },
    { label: () => t('side.library') + '…', action: openLibrary },
    '-',
    { label: () => t('menu.showWorkspace'), disabled: () => !H.health?.workspace?.exists, action: () => reveal('') },
    { label: () => t('menu.showTaskFolder'), disabled: () => !S.task, action: () => reveal(taskFolder()) },
    '-',
    { label: () => t('settings.title') + '…', hint: MOD + ',', action: () => openSettings() },
    { label: () => t('menu.welcome'), action: () => openWelcome({ onDone: afterSettings }) },
  ] },
  { title: () => t('menu.view'), items: [
    { label: () => t('view.material'), hint: '1', radio: () => viewer.mode === 'material', action: () => setViewMode('material') },
    { label: () => t('view.clay'), hint: '2', radio: () => viewer.mode === 'clay', action: () => setViewMode('clay') },
    { label: () => t('view.wire'), hint: '3', radio: () => viewer.mode === 'wire', action: () => setViewMode('wire') },
    '-',
    { label: () => t('view.flat'), hint: 'F', checked: () => viewer.flat, action: toggleFlat },
    { label: () => t('view.fit.hint'), hint: 'Home', disabled: () => !viewer.root, action: () => viewer.fit() },
    '-',
    { label: () => t('theme.light'), radio: () => getTheme() === 'light', action: () => setThemeUi('light') },
    { label: () => t('theme.dark'), radio: () => getTheme() === 'dark', action: () => setThemeUi('dark') },
    { label: () => t('theme.system'), radio: () => getTheme() === 'system', action: () => setThemeUi('system') },
    '-',
    { label: () => t('menu.bigger'), hint: MOD + '+', action: () => setScaleUi(getScale() + 0.05) },
    { label: () => t('menu.smaller'), hint: MOD + '−', action: () => setScaleUi(getScale() - 0.05) },
    { label: () => t('menu.normalSize'), hint: MOD + '0', action: () => setScaleUi(1) },
  ] },
  { title: () => t('menu.task'), items: [
    { label: () => t('chat.stop'), disabled: () => !S.task?.running, action: () => api(`/tasks/${S.task.id}/stop`, { method: 'POST' }).then(() => refreshTask()) },
    { label: () => t('task.openSpec'), disabled: () => !S.task?.media?.spec, action: () => openDoc(S.task.media.spec) },
    '-',
    { label: () => t('menu.downloadModel'), disabled: () => !S.task?.media?.models?.length, action: () => download(S.task.media.models[0].path) },
    { label: () => t('menu.downloadBlend'), disabled: () => !S.task?.media?.blend, action: () => download(S.task.media.blend) },
    '-',
    { label: () => t('task.done'), disabled: () => !S.task || S.task.state === 'done', action: () => patch({ state: 'done' }) },
    { label: () => t('task.reopen'), disabled: () => !S.task || S.task.state !== 'done', action: () => patch({ state: 'open' }) },
  ] },
  { title: () => 'Blender', items: [
    { label: () => t('bl.openWindow'), action: async () => {
      try { const r = await api('/blender/launch', { method: 'POST', body: {} }); if (r.code) toast(errText(r), true); } catch (e) { toast(errText(e), true); }
      renderBlender();
    } },
    { label: () => t('menu.checkBlender'), action: async () => {
      const v = await api('/blender').catch(() => ({ online: false }));
      toast(v.online ? t('bl.running', { v: v.version || '' }) : t('blender.auto'), !v.online && H.health?.blender?.bin === false);
    } },
    '-',
    { label: () => t('menu.blenderSettings'), action: () => openSettings('blender') },
  ] },
  { title: () => t('menu.help'), items: [
    { label: () => t('help.title'), hint: 'F1', action: openHelp },
    '-',
    { label: () => t('menu.github'), action: () => window.open(REPO, '_blank') },
    { label: () => t('menu.releases'), action: () => window.open(REPO + '/releases', '_blank') },
    { label: () => t('menu.issue'), action: () => window.open(REPO + '/issues/new', '_blank') },
    '-',
    { label: () => t('about.title'), action: () => openAbout(S.meta?.version || '') },
  ] },
]);
onLangChange(() => menuBar.relabel());

// Открыть модель с диска — просто посмотреть, в рабочую папку она не копируется.
$('#open-model').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  S.autoFollow = false;
  S.shown = 'local:' + f.name;
  $('#empty').hidden = true;
  const url = URL.createObjectURL(f);
  try { await viewer.load(url, f.name.split('.').pop().toLowerCase()); } catch (err) { toast(t('viewer.fail', { msg: err.message }), true); }
  URL.revokeObjectURL(url);
  renderOutputs();
});

// Клавиши: цифры и буквы — когда курсор не в поле ввода; с ⌘ — всегда.
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'F1') { e.preventDefault(); openHelp(); return; }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); selectTask(null); return; }
  if (mod && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setScaleUi(getScale() + 0.05); return; }
  if (mod && e.key === '-') { e.preventDefault(); setScaleUi(getScale() - 0.05); return; }
  if (mod && e.key === '0') { e.preventDefault(); setScaleUi(1); return; }
  if (typing || mod || e.altKey) return;
  if (e.key === '1') setViewMode('material');
  else if (e.key === '2') setViewMode('clay');
  else if (e.key === '3') setViewMode('wire');
  else if (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'а') toggleFlat();
  else if (e.key === 'Home') viewer.fit();
});

async function boot() {
  const [settings, meta] = await Promise.all([api('/settings'), api('/meta')]);
  S.meta = meta;
  applyUi(settings.ui);
  applyDOM();
  $('#version').textContent = 'v' + S.meta.version;
  await refreshHealth();
  renderHealth();
  await Promise.all([refreshTasks(), refreshLibrary(), renderBlender()]);
  const running = S.tasks.find((x) => x.agent_state === 'running');
  if (running) await selectTask(running.id);
  else renderPanel();
  // Первый запуск — окно приветствия с настройкой по шагам; потом, если
  // что-то отвалилось (удалили Blender, вышли из Claude), — сразу настройки.
  if (!settings.onboarded) openWelcome({ onDone: afterSettings });
  else if (blockers().length) openSettings();
  // Ссылка вида #model=out/<папка>/<файл>.glb открывает модель сразу.
  const deep = new URLSearchParams(location.hash.slice(1)).get('model');
  if (deep) showModel(deep, { manual: true });

  refreshAccount();
  setInterval(refreshAccount, 60000);
  setInterval(() => { refreshTask().catch(() => {}); }, 1500);
  setInterval(() => { refreshTasks().catch(() => {}); }, 3000);
  setInterval(() => { refreshLibrary().catch(() => {}); renderBlender(); refreshHealth().then(renderHealth, () => {}); }, 8000);
}

boot().catch((e) => toast('3DModelist: ' + errText(e), true));
