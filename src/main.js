// 3DModelist — страница. Состояние живёт на сервере (рабочая папка и
// настройки), страница его опрашивает и показывает; своего хранилища у неё нет.

import { Viewer } from './viewer.js';
import { $, el, esc, fileUrl, base, money, api, toast, segment, errText } from './ui.js';
import { t, num, applyDOM, onLangChange, setLang, getLang } from './i18n.js';
import { applyTheme, applyScale, onScaleChange, getScale, getTheme } from './prefs.js';
import { openSettings, refreshHealth, blockers, setOnChange, H } from './settings.js';
import { openWelcome } from './welcome.js';
import { splitSheet } from './sheet.js';
import { MenuBar } from './menubar.js';
import { openHelp, openAbout, REPO } from './help.js';
import { Pins } from './pins.js';
import { Tools } from './tools.js';

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
  shownVersion: null,     // номер версии в окне (живая модель агента), иначе null
  autoFollow: true,       // сам переключаться на новую модель задачи
  framesKey: '',
  howOpen: new Set(),     // задачи, где «Как строится» раскрыли руками
  howClosed: new Set(),   // …и где свернули до старта
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
// Строка над моделью: версия, габариты (как в Blender: ширина × глубина ×
// высота) и треугольники. Если в спеке задачи есть габариты и полигонаж —
// числа зелёные, когда попадают, и оранжевые, когда нет.
function renderModelInfo() {
  const i = modelInfo;
  const box = $('#model-info');
  if (!i) { box.replaceChildren(); return; }
  const size = [i.size[0], i.size[2], i.size[1]];
  const tk = S.task;
  const mine = tk && S.shown && (S.shownVersion != null || S.shown.startsWith(`out/${tk.slug}/`));
  const tgt = mine ? tk.media?.target : null;
  const mark = (ok) => (ok == null ? '' : ok ? 'ok' : 'warn');
  const sizeOk = tgt?.size ? size.every((v, k) => !tgt.size[k] || Math.abs(v - tgt.size[k]) / tgt.size[k] <= 0.1) : null;
  const trisOk = tgt?.tris ? i.tris >= tgt.tris[0] && i.tris <= tgt.tris[1] : null;
  const bits = [];
  if (S.shownVersion != null) bits.push(el('span', {}, t('viewer.ver', { n: S.shownVersion })));
  bits.push(el('span', { class: mark(sizeOk), title: tgt?.size ? t('info.spec', { v: tgt.size.map((v) => v.toFixed(2)).join(' × ') + ' м' }) : t('info.size') },
    t('info.size.v', { size: size.map((v) => v.toFixed(2)).join(' × ') })));
  bits.push(el('span', { class: mark(trisOk), title: tgt?.tris ? t('info.spec', { v: tgt.tris.map((v) => num(v)).join('–') }) : '' },
    t('info.tris', { n: num(i.tris) })));
  bits.push(el('span', {}, i.ext.toUpperCase()));
  box.replaceChildren(...bits.flatMap((b, k) => (k ? [' · ', b] : [b])));
}
viewer.onInfo = (i) => { modelInfo = i; renderModelInfo(); };
onScaleChange((k) => viewer.setScale(k));
viewer.setScale(getScale());

// Метки на модели: уходят агенту со следующим сообщением.
const pins = new Pins(viewer, $('#viewport'), {
  context: () => ({ version: S.shownVersion, model: S.shown }),
  onChange: () => {
    $('#pin').classList.toggle('on', pins.mode);
    document.querySelector('.pin-quick')?.classList.toggle('on', pins.mode);
    renderPinsList();
  },
});
function togglePinMode(on = !pins.mode) { pins.setMode(on); }
$('#pin').addEventListener('click', () => togglePinMode());

// Инструменты окна: референс задачи поверх модели, части, ракурсы, пол, человек, свет.
const tools = new Tools(viewer, $('#viewport'), {
  refs: () => (S.task?.refs || []).map((p) => fileUrl(p)),
  history: {
    items: () => historyItems().map((x) => ({ ...x, thumbUrl: x.thumb && fileUrl(x.thumb) })),
    shown: () => S.shown,
    busy: () => !!S.task?.running,
    // Последнюю версию — с автослежением за новыми; старую — «вручную».
    pick: (x) => {
      const newest = historyItems()[0];
      S.autoFollow = x.key === newest?.key;
      showModel(x.path, { version: x.version, manual: !S.autoFollow });
    },
    restore: async (n) => {
      try {
        await api(`/tasks/${S.task.id}/agent`, { method: 'POST', body: { restore: n } });
        S.autoFollow = true;                   // восстановленная версия придёт новой — показать её
        await refreshTask();
      } catch (e) { toast(errText(e), true); }
    },
  },
  onChange: () => {},
});

// Метки → то, что уходит на сервер: точка в координатах Blender (Z вверх),
// снимок окна с номерами — агент прочитает его глазами.
function marksPayload() {
  if (!pins.list.length) return null;
  const last = pins.list[pins.list.length - 1];
  const mark = getComputedStyle(document.documentElement).getPropertyValue('--pin').trim() || '#5b6ee1';
  return {
    version: pins.list.map((p) => p.version).filter((v) => v != null).pop() ?? null,
    model: last.model,
    image: viewer.shot(pins.list, { mark }),
    pins: pins.list.map((p) => ({ part: p.part, note: p.note.trim(), point: [p.local[0], -p.local[2], p.local[1]] })),
  };
}

// Список меток над полем сообщения: щелчок — открыть замечание, ✕ — убрать.
function renderPinsList() {
  const box = $('#pins-list');
  if (!box) return;
  box.hidden = !pins.list.length;
  if (!pins.list.length) { box.replaceChildren(); return; }
  box.replaceChildren(
    el('div', { class: 'row between' },
      el('span', { class: 'muted' }, t('pins.title')),
      el('button', { class: 'link-btn', onclick: () => pins.clear() }, t('pins.clear'))),
    ...pins.list.map((p, i) => el('div', { class: 'pin-chip' + (pins.editing === p ? ' on' : ''), onclick: (e) => { if (!e.target.closest('button')) pins.open(p); } },
      el('span', { class: 'pin-n' }, String(i + 1)),
      el('span', { class: 'pc-part' }, p.part || t('pin.noPart')),
      el('span', { class: 'pc-note' + (p.note.trim() ? '' : ' dim') }, p.note.trim() || t('pins.noNote')),
      el('button', { class: 'pc-x', title: t('pin.remove'), onclick: () => pins.remove(p) }, '✕'))));
}

async function showModel(rel, { manual = false, version = null } = {}) {
  if (manual) S.autoFollow = false;
  if (S.shown === rel && viewer.root) return;
  // Версии одной задачи сравниваются с одного ракурса — камеру не трогаем.
  const keepView = version != null && S.shownVersion != null && !!viewer.root;
  S.shown = rel;
  S.shownVersion = version;
  $('#empty').hidden = true;
  const busy = el('div', { class: 'loading' }, t('viewer.loading', { name: base(rel) }));
  $('#viewport').append(busy);
  try {
    await viewer.load(fileUrl(rel), undefined, { keepView });
  } catch (e) {
    toast(t('viewer.fail', { msg: e.message }), true);
    S.shown = null;
    S.shownVersion = null;
  } finally {
    busy.remove();
  }
  if (viewer.root) tools.modelLoaded();
  renderModelInfo();
  tools.renderHistory();
  renderModelBar();
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
  if (tk.agent_state === 'waiting' || tk.gen_state === 'done') return el('span', { class: 'badge wait' }, t('badge.waiting'));
  return el('span', { class: 'badge' }, t('badge.new'));
}

const routeName = (r) => t(r === 'generator' ? 'route.generator.short' : 'route.script.short');

function renderTasks() {
  const box = $('#tasks');
  box.replaceChildren(...(S.tasks.length ? S.tasks.map((tk) => el('div', { class: 'item-wrap' },
    el('button', {
      class: 'item' + (S.sel === tk.id ? ' sel' : ''),
      onclick: () => selectTask(tk.id),
    },
    el('div', { class: 'body' },
      el('div', { class: 't' }, tk.name),
      el('div', { class: 's' }, routeName(tk.route) + (tk.spent_usd ? ' · ' + money(tk.spent_usd) : ''))),
    taskBadge(tk)),
    el('button', { class: 'item-del', title: t('task.delete'), onclick: () => deleteTask(tk) }, trashIcon())))
    : [el('div', { class: 'none' }, t('side.noTasks'))]));
}

const trashIcon = () => el('span', { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>' });

// Готовая модель: справа — только референсы и скачивание. Чат, генератор и
// агенты не нужны; «Вернуть в работу» — в строке под моделью (владелец 27.09).
function renderDonePanel() {
  const tk = S.task;
  const menuBtn = el('button', { class: 'icon-btn', title: t('task.menu'), onclick: (e) => taskMenu(e.currentTarget, tk) },
    el('span', { html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>' }));
  const dl = (fmt) => el('button', { class: 'btn dl-btn', onclick: () => downloadAs(fmt) },
    el('span', { class: 'dl-fmt' }, fmt.toUpperCase()), el('span', { class: 'dl-hint' }, t('dl.' + fmt + '.hint')));
  const refs = tk.refs || [];
  $('#panel').replaceChildren(
    el('div', { class: 'panel-head' },
      el('div', { class: 'row between' }, el('div', { class: 'panel-title' }, tk.name), menuBtn),
      el('div', { class: 'task-status' }, el('span', { class: 'badge done' }, t('status.done')),
        el('span', { class: 'panel-sub' }, [routeName(tk.route), t('task.spent', { sum: money(tk.spent_usd) })].join(' · ')))),
    el('div', { class: 'panel-scroll' },
      refs.length > 0 && el('div', { class: 'field' },
        el('div', { class: 'label' }, t('done.refs')),
        el('div', { class: 'refs done-refs' }, ...refs.map((p, i) => el('div', {
          class: 'ref', style: `background-image:url("${fileUrl(p)}")`, title: p, onclick: () => openImages(refs, i),
        })))),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, t('dl.title')),
        modelSource() ? el('div', { class: 'dl-list' }, dl('glb'), dl('fbx'), dl('obj')) : el('div', { class: 'muted' }, t('dl.none'))),
      el('div', { class: 'muted done-hint' }, t('done.hint'))));
  tools.render();
  renderModelInfo();
}

// Какую модель скачивать: открытую в окне, если она этой задачи, иначе последнюю.
function modelSource() {
  const tk = S.task;
  if (!tk) return null;
  const mine = S.shown && (S.shown.startsWith(`out/${tk.slug}/`) || S.shown.startsWith(`runs/studio/${tk.id}/`));
  return mine ? S.shown : historyItems()[0]?.path || null;
}

// Скачать в формате: тот же — сразу, другой — сервер переводит Blender'ом без окна.
async function downloadAs(fmt) {
  const src = modelSource();
  if (!src) return;
  const same = src.split('.').pop().toLowerCase() === fmt;
  if (!same) toast(t('dl.preparing', { fmt: fmt.toUpperCase() }));
  try {
    const r = await fetch(`/api/export?path=${encodeURIComponent(src)}&fmt=${fmt}&name=${encodeURIComponent(S.task.slug)}`);
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw Object.assign(new Error(e.error || r.statusText), e); }
    const name = decodeURIComponent((/filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '') || [])[1] || `${S.task.slug}.${fmt}`);
    const url = URL.createObjectURL(await r.blob());
    const a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { toast(errText(e), true); }
}

// Строка под моделью задачи — как нижняя панель Tripo: скачать, папка, готово.
function renderModelBar() {
  const bar = $('#model-bar');
  const tk = S.task;
  const src = modelSource();
  bar.hidden = !tk || !S.shown || !src;
  if (bar.hidden) return;
  const done = tk.state === 'done';
  const dlBtn = el('button', { class: 'btn', onclick: (e) => {
    document.querySelector('.dl-pop')?.remove();
    const pop = el('div', { class: 'dl-pop' }, ...['glb', 'fbx', 'obj'].map((f) => el('button', {
      class: 'menu-item', onclick: () => { pop.remove(); downloadAs(f); },
    }, el('span', {}), el('span', {}, f.toUpperCase() + ' — ' + t('dl.' + f + '.hint')), el('span', {}))));
    e.currentTarget.parentElement.append(pop);
    const off = (ev) => { if (!pop.contains(ev.target)) { pop.remove(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
  } }, '↓ ' + t('bar.download'));
  bar.replaceChildren(
    el('div', { class: 'bar-dl' }, dlBtn),
    host?.openPath && el('button', { class: 'btn', onclick: () => reveal(src.slice(0, src.lastIndexOf('/'))) }, t('bar.folder')),
    done
      ? el('button', { class: 'btn', onclick: () => patch({ state: 'open' }) }, '↩ ' + t('task.reopen'))
      : el('button', { class: 'btn primary', disabled: !!tk.running, title: t('task.done.hint'), onclick: () => patch({ state: 'done' }) }, '✓ ' + t('bar.done')));
}

// Короткое имя модели для строки «Как строится».
const modelShort = (id) => FAMILY_NAME[id] || (S.meta?.models || []).find((m) => m.id === id)?.label || id || '';

// Меню «⋯» в шапке задачи: скачать, спека, кадры агента, папка, готово, удалить.
function taskMenu(anchor, tk) {
  document.querySelector('.pop-menu')?.remove();
  const frames = (tk.media?.frames || []).map((f) => f.path);
  const item = (label, action, { disabled = false, danger = false } = {}) => el('button', {
    class: 'menu-item' + (danger ? ' danger' : ''), disabled,
    onclick: () => { menu.remove(); action(); },
  }, el('span', {}), el('span', {}, label), el('span', {}));
  const menu = el('div', { class: 'pop-menu' },
    item(t('task.openSpec'), () => openDoc(tk.media.spec), { disabled: !tk.media?.spec }),
    item(t('menu.frames'), () => openImages(frames, 0), { disabled: !frames.length }),
    el('div', { class: 'menu-sep' }),
    item(t('task.delete'), () => deleteTask(tk), { danger: true, disabled: !!tk.running }));
  const r = anchor.getBoundingClientRect();
  const k = getScale();
  menu.style.top = (r.bottom / k + 4) + 'px';
  menu.style.right = ((window.innerWidth - r.right) / k) + 'px';
  document.body.append(menu);
  const off = (e) => { if (!menu.contains(e.target) && e.target !== anchor) { menu.remove(); document.removeEventListener('pointerdown', off, true); } };
  setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
}

// Удалить задачу: переписка и версии — в Корзину, готовые файлы модели остаются.
async function deleteTask(tk) {
  if (tk.agent_state === 'running') { toast(errText({ code: 'busy' }), true); return; }
  if (!confirm(t('task.delete.confirm', { name: tk.name }))) return;
  try {
    await api(`/tasks/${tk.id}`, { method: 'DELETE' });
    toast(t('task.deleted', { name: tk.name }));
    if (S.sel === tk.id) await selectTask(null);
    await refreshTasks();
  } catch (e) { toast(errText(e), true); }
}

function renderLibrary() {
  const box = $('#library');
  box.replaceChildren(...(S.library.length ? S.library.map((m) => {
    const main = m.files.find((f) => /\.glb$/i.test(f.path) && !f.path.includes('/gen_')) || m.files[0];
    const active = m.files.some((f) => f.path === S.shown);
    return el('div', { class: 'item-wrap' },
      el('button', {
        class: 'item' + (active ? ' sel' : ''),
        title: m.files.map((f) => f.path).join('\n'),
        onclick: () => showModel(main.path, { manual: true }),
      },
      el('div', { class: 'thumb', style: m.preview ? `background-image:url("${fileUrl(m.preview)}")` : '' }),
      el('div', { class: 'body' },
        el('div', { class: 't' }, m.name),
        el('div', { class: 's' }, t('lib.files', { n: m.files.length }) + (m.blend ? ' · .blend' : '')))),
      el('button', { class: 'item-del', title: t('lib.trash'), onclick: () => trashLibraryModel(m) }, trashIcon()));
  }) : [el('div', { class: 'none' }, t('side.noModels'))]));
}

// Готовую модель — в Корзину: файлы out/, .blend и кадры; скрипт и референсы остаются.
async function trashLibraryModel(m, after = () => {}) {
  if (!confirm(t('lib.trash.confirm', { name: m.name }))) return;
  try {
    await api(`/library/${encodeURIComponent(m.name)}/trash`, { method: 'POST' });
    if (S.shown && S.shown.startsWith(`out/${m.name}/`)) clearViewer();
    toast(t('lib.trashed', { name: m.name }));
    await refreshLibrary();
    after();
  } catch (e) { toast(errText(e), true); }
}

// Пустое окно: у новой задачи модели ещё нет — чужую не показываем.
function clearViewer() {
  viewer.clear();
  S.shown = null;
  S.shownVersion = null;
  $('#empty').hidden = false;
  renderModelInfo();
  renderModelBar();
  tools.renderHistory();
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

  // Ход агента: что делается сейчас и сколько идёт это действие. Действие
  // тянется дольше обычного — предупреждаем и даём «Перезапустить»: стоп и
  // сразу «Продолжай» — агент продолжит с того же места (та же сессия).
  let action = '';
  let lastT = tk.turn_started_at || now;
  for (let i = S.events.length - 1; i >= 0; i--) {
    const ev = S.events[i];
    if (i === S.events.length - 1) lastT = Math.max(lastT, ev.t);
    if (ev.kind === 'tool') { action = toolText(ev); break; }
    if (ev.kind === 'text') { action = ev.text.split('\n')[0].slice(0, 120); break; }
    if (ev.kind === 'user' || ev.key === 'ev.agentStarted') break;
  }
  const since = tk.turn_started_at || now;
  const quiet = now - lastT;                       // сколько нет новых действий
  const stalled = quiet > 600;
  box.replaceChildren(
    el('div', { class: 'proc-head' },
      el('span', { class: 'spinner' }),
      el('div', {},
        el('div', { class: 'proc-title' }, t('proc.agent.title')),
        el('div', { class: 'proc-sub' }, action ? t('proc.agent.action', { action }) : t('proc.agent.starting'))),
      el('div', { class: 'proc-time', title: t('proc.agent.total') }, clock(now - since))),
    el('div', { class: 'bar indet' }, el('div', { class: 'bar-fill' })),
    el('div', { class: 'proc-note' + (stalled ? ' warn' : '') }, stalled
      ? t('proc.agent.stalled', { time: clock(quiet) })
      : t('proc.agent.quiet', { time: clock(quiet) })),
    stalled && el('div', { class: 'row' },
      el('button', { class: 'btn primary', onclick: restartTurn }, t('proc.agent.restart')),
      el('button', { class: 'btn ghost', onclick: () => api(`/tasks/${tk.id}/stop`, { method: 'POST' }).then(() => refreshTask()) }, t('chat.stop'))));
}

// «Перезапустить»: остановить ход и, как только он погас, отправить «Продолжай».
async function restartTurn() {
  const id = S.task?.id;
  if (!id) return;
  try {
    await api(`/tasks/${id}/stop`, { method: 'POST' });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const tk = await api(`/tasks/${id}`);
      if (!tk.running) break;
    }
    await api(`/tasks/${id}/agent`, { method: 'POST', body: { message: t('quick.go.msg') } });
    await refreshTask();
  } catch (e) { toast(errText(e), true); }
}
setInterval(() => { try { renderProcess(); } catch { /* до загрузки */ } }, 1000);

// ── правая панель: задача ─────────────────────────────────────────────────
function renderTaskPanel() {
  const tk = S.task;
  const panel = $('#panel');
  if (tk.state === 'done') { renderDonePanel(); return; }
  const running = tk.running;
  const started = !!tk.agent?.session_id;

  // Шапка: имя, понятный статус и меню действий; под ней — что дал человек.
  const genBusy = ['queued', 'running', 'downloading'].includes(tk.gen?.state);
  const status = running ? ['run', t('status.running')]
    : genBusy ? ['run', t('status.gen')]
      : tk.state === 'done' ? ['done', t('status.done')]
        : started ? ['wait', t('status.waiting')]
          : tk.route === 'generator' && tk.gen?.state === 'done' ? ['wait', t('status.genDone')] : ['', t('status.new')];
  const sub = [routeName(tk.route), t('task.spent', { sum: money(tk.spent_usd) })];
  if (tk.limit5h != null) sub.push(t('task.limit', { p: Math.round(tk.limit5h * 100) }));
  const menuBtn = el('button', { class: 'icon-btn', title: t('task.menu'), onclick: (e) => taskMenu(e.currentTarget, tk) },
    el('span', { html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>' }));
  const head = el('div', { class: 'panel-head' },
    el('div', { class: 'row between' }, el('div', { class: 'panel-title' }, tk.name), menuBtn),
    el('div', { class: 'task-status' }, el('span', { class: 'badge ' + status[0] }, status[1]), el('span', { class: 'panel-sub' }, sub.join(' · '))),
    (tk.refs || []).length > 0 && el('div', { class: 'refs-mini' }, ...(tk.refs || []).map((p, i) => el('div', {
      class: 'ref', style: `background-image:url("${fileUrl(p)}")`, title: p, onclick: () => openImages(tk.refs, i),
    }))));

  // «Как строится» — выбор пути, генератор и агенты. До старта раскрыто,
  // потом свёрнуто в одну строку: главное место — у чата.
  const produced = tk.gen?.state === 'done' || (tk.versions || []).length > 0 || (tk.media?.models || []).length > 0;
  const how = el('details', { class: 'howto', open: S.howOpen.has(tk.id) || (!started && !produced && !S.howClosed.has(tk.id)) },
    el('summary', {},
      el('span', { class: 'how-title' }, t('how.title')),
      el('span', { class: 'how-sum' }, tk.route === 'generator'
        ? t('how.sum.gen', { gen: tk.gen?.label || genMeta(S.genDraft?.model || 'tripo3d/p2/image-to-3d')?.label || '', model: modelShort(tk.agent?.model) })
        : t('how.sum.script', { model: modelShort(tk.agent?.model) }))),
    el('div', { class: 'how-body' },
      el('div', { class: 'field' },
        el('div', { class: 'label' }, t('form.route')),
        segment([
          ['script', t('route.script'), t('route.script.hint')],
          ['generator', t('route.generator'), t('route.generator.hint')],
        ], tk.route, (v) => { if (!running && v !== tk.route) patch({ route: v }); }, 'full')),
      tk.route === 'generator' && genCard(tk),
      agentBlock(tk.agent, (p) => patch({ agent: { ...tk.agent, ...p } }),
        t(tk.route === 'generator' ? 'agents.afterGen' : 'agents.build'))));
  how.addEventListener('toggle', () => {
    if (how.open) { S.howOpen.add(tk.id); S.howClosed.delete(tk.id); } else { S.howOpen.delete(tk.id); S.howClosed.add(tk.id); }
  });
  const blocks = [how];
  blocks.push(el('div', { class: 'feed', id: 'feed' }));

  const ta = el('textarea', {
    class: 'textarea', id: 'msg',
    placeholder: started ? t('chat.ph') : t('chat.ph.first'),
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); },
  });
  const send = async (text) => {
    const msg = text ?? ta.value.trim();
    const marks = marksPayload();
    if (started && !msg && !marks) return;
    try {
      await api(`/tasks/${tk.id}/agent`, { method: 'POST', body: { message: msg, marks } });
      ta.value = '';
      if (marks) { pins.clear(); togglePinMode(false); }
      S.autoFollow = true;                     // ответ агента — новую версию — показать сразу
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
    el('div', { class: 'pins-list', id: 'pins-list', hidden: true }),
    !running && started && el('div', { class: 'quick' },
      el('button', { class: 'btn', onclick: () => send(t('quick.ok.msg')) }, t('quick.ok')),
      el('button', { class: 'btn', onclick: () => send(t('quick.go.msg')) }, t('quick.go')),
      // Точечная правка — там же, где пишут правки: метка на модели + слова.
      el('button', { class: 'btn pin-quick' + (pins.mode ? ' on' : ''), title: t('view.pin.hint'), onclick: () => togglePinMode() }, '📍 ' + t('quick.pin'))),
    !running && ta,
    !running && (started
      ? el('button', { class: 'btn primary', onclick: () => send() }, t('chat.send'))
      : el('button', { class: 'btn primary big', disabled: !genReady, onclick: () => send(ta.value.trim()) },
        tk.route === 'generator' ? t('chat.handOver') : t('chat.startAgent'))),
  );

  panel.replaceChildren(head, el('div', { class: 'panel-scroll', id: 'task-scroll' }, ...blocks), foot);
  renderFeed(true);
  renderPinsList();
  tools.render();                       // кнопка референса — по референсам этой задачи
  renderModelInfo();                    // сверка со спекой — по спеке этой задачи
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
const toolText = (ev) => {
  const txt = ev.verb ? (ev.verb === 'bash' || ev.verb === 'other' ? ev.arg : t('tool.' + ev.verb, { arg: ev.arg })) : ev.text || '';
  return ev.sub ? t('who.' + (ev.sub === 'critic' ? 'critic' : 'helper')) + ': ' + txt : txt;
};

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
      case 'user': return el('div', { class: 'ev user' }, evText(n),
        n.marks && el('div', { class: 'ev-marks' },
          ...n.marks.pins.map((p) => el('div', { class: 'ev-mark' }, el('span', { class: 'pin-n' }, String(p.n)),
            el('span', {}, (p.part || t('pin.noPart')) + (p.note ? ' — ' + p.note : '')))),
          n.marks.image && el('img', { src: fileUrl(n.marks.image), onclick: () => openImages([n.marks.image], 0) })));
      case 'result': return el('div', { class: 'ev result' + (n.error ? ' err' : '') }, evText(n));
      case 'error': return el('div', { class: 'ev error' }, evText(n));
      case 'gen': return el('div', { class: 'ev genev' }, evText(n));
      default: return el('div', { class: 'ev sys' }, evText(n));
    }
  }));
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

async function patch(body) {
  try {
    S.task = await api(`/tasks/${S.sel}`, { method: 'PATCH', body });
    renderTaskPanel();
    renderModelBar();
    refreshTasks();
  } catch (e) { toast(errText(e), true); }
}

function renderPanel() {
  if (S.sel && S.task) renderTaskPanel();
  else renderNewForm();
}

// ── история модели ─────────────────────────────────────────────────────
// Нижней панели нет (этапы, кадры, файлы путали владельца, 27.09): модель
// занимает всё поле, а версии и готовые файлы — в «Истории» справа, как в
// Tripo Studio. Кадры агента — в меню «Задача», скачать — в меню задачи.
function historyItems() {
  const tk = S.task;
  if (!tk) return [];
  const items = (tk.versions || []).map((v) => ({
    key: v.glb, path: v.glb, version: v.n, t: v.t, thumb: v.thumb,
    title: t('viewer.ver', { n: v.n }), sub: t('ver.tip', { n: v.n, time: hhmm(v.t), tris: num(v.tris) }).replace(/^[^·]*·\s*/, ''),
  }));
  for (const m of tk.media?.models || []) {
    const gen = m.path.includes('/gen_');
    const shot = gen && (tk.media.frames || []).find((f) => f.path.startsWith(m.path.slice(0, m.path.lastIndexOf('/') + 1)));
    items.push({ key: m.path, path: m.path, version: null, t: m.mtime, thumb: shot?.path || null,
      title: gen ? t('hist.gen') : t('hist.file'), sub: base(m.path) });
  }
  return items.sort((a, b) => b.t - a.t);
}
const hhmm = (sec) => new Date(sec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Сохранено имя, чтобы не трогать остальной код: док теперь — только история.
function renderDock() { tools.renderHistory(); renderModelBar(); }
function renderOutputs() { tools.renderHistory(); renderModelBar(); }

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
  S.shownVersion = null;
  pins.clear();
  togglePinMode(false);
  renderTasks();
  if (!id) {
    tools.toggle('ref', false);
    clearViewer();
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

  // Новая модель задачи — сразу в окно, пока человек сам ничего не выбрал:
  // последняя версия живой модели или свежая выдача в out/ — что новее.
  const lastVer = tk.versions?.[tk.versions.length - 1];
  const newest = tk.media?.models?.[0];
  if (S.autoFollow) {
    if (lastVer && (!newest || lastVer.t >= newest.mtime)) {
      if (lastVer.glb !== S.shown) showModel(lastVer.glb, { version: lastVer.n });
    } else if (newest && newest.path !== S.shown) showModel(newest.path);
    else if (first && !lastVer && !newest && S.shown) clearViewer();   // у задачи ещё нет модели
  }
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
        el('button', { class: 'btn ghost danger', onclick: () => trashLibraryModel(m, draw) }, t('lib.trash')))));
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
  if (pins.mode) pins.setMode(true);  // подсказка режима меток — на новом языке
  pins.render();
  tools.render();
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
    { label: () => t('view.normals'), hint: '4', radio: () => viewer.mode === 'normals', action: () => setViewMode('normals') },
    '-',
    { label: () => t('view.flat'), hint: 'F', checked: () => viewer.flat, action: toggleFlat },
    { label: () => t('view.fit.hint'), hint: 'Home', disabled: () => !viewer.root, action: () => viewer.fit() },
    { label: () => t('view.pin'), hint: 'M', checked: () => pins.mode, action: () => togglePinMode() },
    '-',
    { label: () => t('rail.ref'), hint: 'R', checked: () => tools.state.ref, disabled: () => !S.task?.refs?.length, action: () => tools.toggle('ref') },
    { label: () => t('rail.parts'), hint: 'P', checked: () => tools.state.parts, action: () => tools.toggle('parts') },
    { label: () => t('hist.hint'), checked: () => tools.state.history, action: () => tools.toggle('history') },
    { label: () => t('rail.grid'), hint: 'G', checked: () => tools.state.grid, action: () => tools.toggle('grid') },
    { label: () => t('rail.human'), hint: 'H', checked: () => tools.state.human, action: () => tools.toggle('human') },
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
    { label: () => t('menu.frames'), disabled: () => !S.task?.media?.frames?.length, action: () => openImages(S.task.media.frames.map((f) => f.path), 0) },
    '-',
    { label: () => t('task.done'), disabled: () => !S.task || S.task.state === 'done', action: () => patch({ state: 'done' }) },
    { label: () => t('task.reopen'), disabled: () => !S.task || S.task.state !== 'done', action: () => patch({ state: 'open' }) },
    { label: () => t('task.delete'), disabled: () => !S.task || !!S.task.running, action: () => deleteTask(S.task) },
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
  try { await viewer.load(url, f.name.split('.').pop().toLowerCase()); tools.modelLoaded(); } catch (err) { toast(t('viewer.fail', { msg: err.message }), true); }
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
  if (e.key === 'Escape' && pins.mode) { if (pins.editing) pins.close(); else togglePinMode(false); return; }
  if (e.key === '1') setViewMode('material');
  else if (e.key === '2') setViewMode('clay');
  else if (e.key === '3') setViewMode('wire');
  else if (e.key === '4') setViewMode('normals');
  else if (e.key.toLowerCase() === 'f' || e.key.toLowerCase() === 'а') toggleFlat();
  else if (e.key.toLowerCase() === 'm' || e.key.toLowerCase() === 'ь') togglePinMode();
  else if ((e.key.toLowerCase() === 'r' || e.key.toLowerCase() === 'к') && S.task?.refs?.length) tools.toggle('ref');
  else if (e.key.toLowerCase() === 'p' || e.key.toLowerCase() === 'з') tools.toggle('parts');
  else if (e.key.toLowerCase() === 'g' || e.key.toLowerCase() === 'п') tools.toggle('grid');
  else if (e.key.toLowerCase() === 'h' || e.key.toLowerCase() === 'р') tools.toggle('human');
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
