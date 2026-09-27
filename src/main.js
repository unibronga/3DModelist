// 3DModelist — страница. Состояние живёт на сервере (рабочая папка и
// настройки), страница его опрашивает и показывает; своего хранилища у неё нет.

import { Viewer } from './viewer.js';

import { $, el, esc, fileUrl, base, money, api, toast, segment } from './ui.js';
import { openSettings, refreshHealth, blockers, setOnChange, H } from './settings.js';
import { openWelcome } from './welcome.js';

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
viewer.onInfo = (i) => {
  $('#model-info').textContent = i
    ? `${i.size.map((v) => v.toFixed(2)).join(' × ')} м · ${i.tris.toLocaleString('ru')} треуг. · ${i.ext.toUpperCase()}`
    : '';
};

async function showModel(rel, { manual = false } = {}) {
  if (manual) S.autoFollow = false;
  if (S.shown === rel && viewer.root) return;
  S.shown = rel;
  $('#empty').hidden = true;
  const busy = el('div', { class: 'loading' }, 'Загружаю ' + base(rel) + '…');
  $('#viewport').append(busy);
  try {
    await viewer.load(fileUrl(rel));
  } catch (e) {
    toast('Не открылась модель: ' + e.message, true);
    S.shown = null;
  } finally {
    busy.remove();
  }
  renderOutputs();
  renderLibrary();
}

document.querySelectorAll('#view-mode button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('#view-mode button').forEach((x) => x.classList.toggle('on', x === b));
  viewer.setMode(b.dataset.mode);
}));
$('#flat').addEventListener('click', (e) => {
  e.currentTarget.classList.toggle('on');
  viewer.setFlat(e.currentTarget.classList.contains('on'));
});
$('#fit').addEventListener('click', () => viewer.fit());

// ── просмотр кадров и спеки ───────────────────────────────────────────────
function openImages(list, i) {
  const lb = $('#lightbox');
  const draw = () => {
    lb.replaceChildren(el('div', {},
      el('img', { src: fileUrl(list[i]) }),
      el('div', { class: 'cap' }, `${list[i]}  ·  ${i + 1} / ${list.length}  ·  ← → листать, Esc закрыть`)));
  };
  lb.onkeydown = null;
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
function taskBadge(t) {
  if (t.agent_state === 'running') return el('span', { class: 'badge run' }, 'идёт');
  if (t.gen_state === 'queued' || t.gen_state === 'running') return el('span', { class: 'badge run' }, 'генерация');
  if (t.state === 'done') return el('span', { class: 'badge done' }, 'готово');
  if (t.gen_state === 'error') return el('span', { class: 'badge err' }, 'ошибка');
  if (t.agent_state === 'waiting') return el('span', { class: 'badge wait' }, 'ждёт тебя');
  return el('span', { class: 'badge' }, 'новая');
}

function renderTasks() {
  const box = $('#tasks');
  box.replaceChildren(...(S.tasks.length ? S.tasks.map((t) => el('button', {
    class: 'item' + (S.sel === t.id ? ' sel' : ''),
    onclick: () => selectTask(t.id),
  },
  el('div', { class: 'body' },
    el('div', { class: 't' }, t.name),
    el('div', { class: 's' }, (t.route === 'generator' ? 'генератор' : 'скрипт') +
      (t.spent_usd ? ' · ' + money(t.spent_usd) : ''))),
  taskBadge(t))) : [el('div', { class: 'none' }, 'Пока пусто')]));
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
      el('div', { class: 's' }, `${m.files.length} файл${m.files.length === 1 ? '' : m.files.length < 5 ? 'а' : 'ов'}` + (m.blend ? ' · .blend' : ''))));
  }) : [el('div', { class: 'none' }, 'В out/ пока нет моделей')]));
}

async function renderBlender() {
  const b = $('#blender');
  try {
    const v = await api('/blender');
    const found = H.health?.blender?.bin !== false;
    // Закрытый Blender — не беда: студия поднимет его сама, когда агент возьмётся за работу.
    b.className = 'blender ' + (v.online ? 'on' : found ? 'idle' : 'off');
    b.querySelector('.txt').textContent = v.online
      ? `Blender · ${v.file || (v.background ? 'без окна' : 'без файла')}`
      : found ? 'Blender запустится сам' : 'Blender не найден';
    b.title = v.online ? `Blender ${v.version || ''}${v.background ? ' — без окна, запущен студией' : ''}\n${v.file || ''}`
      : found ? 'Студия запускает Blender без окна, когда агент начинает работу. Нажми, чтобы открыть его с окном.'
        : 'Для пути «Агент скриптом» нужен Blender — открыть настройки';
  } catch { /* сервер перезапускается */ }
}

// ── правая панель: новая модель ───────────────────────────────────────────

function genMeta(id) { return S.meta.generators.find((g) => g.id === id); }
function genPrice(d) {
  const g = genMeta(d.gen.model);
  return g ? (d.gen.texture ? g.priceTex : g.price) : 0;
}

function readFiles(files) {
  for (const f of files) {
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { toast('Нужна картинка PNG, JPG или WEBP', true); continue; }
    const rd = new FileReader();
    rd.onload = () => {
      S.draft.uploads.push({ name: f.name, data: rd.result });
      if (!S.draft.name) S.draft.name = f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      renderPanel();
    };
    rd.readAsDataURL(f);
  }
}

function agentBlock(agent, onChange) {
  const models = S.meta.agents.map((a) => [a.id, a.label, a.note]);
  const modelers = S.meta.agents.filter((a) => a.modeler).map((a) => [a.id, a.label, a.note]);
  return el('div', { class: 'card' },
    el('div', { class: 'card-h' }, 'Агенты', el('span', { class: 'badge' }, 'в подписке')),
    el('div', { class: 'agent-row' },
      el('span', { class: 'muted' }, 'Моделист'),
      segment(modelers, agent.model, (v) => onChange({ model: v }), 'full')),
    el('div', { class: 'agent-row' },
      el('span', { class: 'muted' }, 'Глубина'),
      segment([['medium', 'Обычная', 'быстрее, на простые пропсы'], ['high', 'Высокая', 'основной режим'], ['max', 'Максимум', 'сложные сцены, дольше']],
        agent.effort, (v) => onChange({ effort: v }), 'full')),
    el('div', { class: 'agent-row' },
      el('span', { class: 'muted' }, 'Критик'),
      segment([...models.map(([v, l]) => [v, l]), ['off', 'Выкл', 'сдавать без приёмщика']],
        agent.critic, (v) => onChange({ critic: v }), 'full')));
}

function genBlock(g, onChange) {
  const meta = genMeta(g.model);
  const detail = meta?.detail;
  const val = g.detail ?? detail?.def;
  return el('div', { class: 'field' },
    el('div', { class: 'label' }, 'Генератор', el('span', { class: 'hint' }, 'платно, fal.ai')),
    el('div', { class: 'gens' }, ...S.meta.generators.map((x) => el('button', {
      class: 'gen' + (x.id === g.model ? ' on' : ''),
      onclick: () => onChange({ model: x.id, detail: null }),
    },
    el('div', {}, el('div', { class: 'gl' }, x.label), el('div', { class: 'gt' }, x.tag)),
    el('div', { class: 'gp' }, money(g.texture ? x.priceTex : x.price))))),
    el('label', { class: 'check' },
      el('input', { type: 'checkbox', checked: g.texture, onchange: (e) => onChange({ texture: e.target.checked }) }),
      el('span', {}, 'С текстурой генератора', el('div', { class: 'muted' }, 'обычно не нужна: цвет ставим сами по спеке'))),
    detail && el('div', { class: 'field' },
      el('div', { class: 'label' }, 'Детализация', el('span', { class: 'hint', id: 'detail-v' }, `${Number(val).toLocaleString('ru')} ${detail.unit}`)),
      el('input', {
        class: 'range', type: 'range', min: detail.min, max: detail.max, step: detail.min, value: val,
        oninput: (e) => {
          g.detail = Number(e.target.value);
          $('#detail-v').textContent = `${g.detail.toLocaleString('ru')} ${detail.unit}`;
        },
      })));
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
      el('button', { title: 'Убрать', onclick: (e) => { e.stopPropagation(); d.uploads.splice(i, 1); renderPanel(); } }, '×'))),
    ...d.refPaths.map((p, i) => el('div', { class: 'ref', style: `background-image:url("${fileUrl(p)}")`, title: p, onclick: () => openImages(d.refPaths, i) },
      el('button', { title: 'Убрать', onclick: (e) => { e.stopPropagation(); d.refPaths.splice(i, 1); renderPanel(); } }, '×'))),
  ];

  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', multiple: true, hidden: true, onchange: (e) => readFiles(e.target.files) });
  const drop = el('div', {
    class: 'drop',
    onclick: () => input.click(),
    ondragover: (e) => { e.preventDefault(); drop.classList.add('over'); },
    ondragleave: () => drop.classList.remove('over'),
    ondrop: (e) => { e.preventDefault(); drop.classList.remove('over'); readFiles(e.dataTransfer.files); },
  },
  el('div', { class: 'big' }, 'Перетащи референс'),
  el('div', { class: 'small' }, 'или нажми · Cmd+V вставит из буфера · можно несколько видов'));

  const pick = el('select', { class: 'select', onchange: (e) => { if (e.target.value && !d.refPaths.includes(e.target.value)) d.refPaths.push(e.target.value); renderPanel(); } },
    el('option', { value: '' }, 'Взять из refs/ проекта…'));
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
  const noBlender = !isGen && !H.health?.blender?.bin;
  if (noBlender) todo.push('для пути «Агент скриптом» нужен Blender');
  const start = el('button', {
    class: 'btn big wide ' + (isGen ? 'accent' : 'primary'),
    disabled: !hasRef || !d.name.trim() || todo.length > 0,
    onclick: () => createAndStart(start),
  }, isGen ? `Сгенерировать · ${money(price)}` : 'Создать и запустить агента');

  panel.replaceChildren(
    el('div', { class: 'panel-head' },
      el('div', { class: 'panel-title' }, 'Новая модель'),
      el('div', { class: 'panel-sub' }, 'Референс → спека → форма → приёмка → выдача')),
    el('div', { class: 'panel-scroll' },
      todo.length > 0 && el('div', { class: 'notice' },
        el('b', {}, 'Сначала настройка'),
        el('div', {}, todo.join(' · ')),
        el('button', { class: 'btn primary', onclick: () => openSettings() }, 'Открыть настройки')),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, 'Референс', el('span', { class: 'req' }, 'НУЖЕН')),
        drop, input, el('div', { class: 'refs' }, ...refThumbs), pick),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, 'Название'),
        el('input', { class: 'input', value: d.name, placeholder: 'например: Сундук капитана', oninput: (e) => { d.name = e.target.value; start.disabled = !hasRef || !d.name.trim() || todo.length > 0; } })),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, 'Что сделать', el('span', { class: 'hint' }, 'необязательно')),
        el('textarea', { class: 'textarea', placeholder: 'Размер, для чего модель, на что смотреть в референсе…', oninput: (e) => { d.brief = e.target.value; } }, d.brief)),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, 'Кто строит форму'),
        segment([
          ['script', 'Агент скриптом', 'Интерьеры, мебель, пропсы — конструкцией по размерам. В подписке.'],
          ['generator', 'Генератор', 'Персонажи и органика — нейросеть по картинке. Платно.'],
        ], d.route, (v) => { d.route = v; renderPanel(); }, 'full')),
      isGen ? genBlock(d.gen, (p) => { Object.assign(d.gen, p); renderPanel(); }) : null,
      agentBlock(d.agent, (p) => { Object.assign(d.agent, p); renderPanel(); }),
    ),
    el('div', { class: 'panel-foot' },
      el('div', { class: 'cost' }, 'Агенты', el('b', {}, 'в подписке')),
      isGen && el('div', { class: 'cost' }, 'Генерация', el('b', {}, money(price))),
      start),
  );
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
    if (!confirm(`Запустить ${g.label} за ${money(genPrice(d))}? Деньги спишутся с fal.`)) return;
  }
  btn.disabled = true;
  btn.textContent = 'Создаю…';
  try {
    const task = await api('/tasks', {
      method: 'POST',
      body: { name: d.name, brief: d.brief, route: d.route, uploads: d.uploads, refPaths: d.refPaths, agent: d.agent },
    });
    if (isGen) await api(`/tasks/${task.id}/generate`, { method: 'POST', body: { ...d.gen } });
    else await api(`/tasks/${task.id}/agent`, { method: 'POST', body: {} });
    S.draft = freshDraft();
    S.refsTree = null;
    await refreshTasks();
    await selectTask(task.id);
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
    btn.textContent = 'Попробовать ещё раз';
  }
}

// ── правая панель: задача ─────────────────────────────────────────────────
function renderTaskPanel() {
  const t = S.task;
  const panel = $('#panel');
  const running = t.running;
  const started = !!t.agent?.session_id;

  const head = el('div', { class: 'panel-head' },
    el('div', { class: 'row between' },
      el('div', { class: 'panel-title' }, t.name),
      t.state === 'done'
        ? el('button', { class: 'btn ghost', onclick: () => patch({ state: 'open' }) }, 'Вернуть в работу')
        : el('button', { class: 'btn ghost', title: 'Отметить модель сданной', onclick: () => patch({ state: 'done' }) }, '✓ Готово')),
    el('div', { class: 'panel-sub' },
      `папка ${t.slug} · ${t.route === 'generator' ? 'генератор' : 'скрипт'} · потрачено ${money(t.spent_usd)}` +
      (t.limit5h != null ? ` · лимит подписки ${Math.round(t.limit5h * 100)}%` : '')));

  const refs = el('div', { class: 'refs' }, ...(t.refs || []).map((p, i) => el('div', {
    class: 'ref', style: `background-image:url("${fileUrl(p)}")`, title: p, onclick: () => openImages(t.refs, i),
  })));

  const blocks = [refs];
  if (t.media?.spec) {
    blocks.push(el('button', { class: 'btn wide', onclick: () => openDoc(t.media.spec) }, 'Открыть спеку'));
  }
  if (t.route === 'generator') blocks.push(genCard(t));
  blocks.push(agentBlock(t.agent, (p) => patch({ agent: { ...t.agent, ...p } })));
  const feed = el('div', { class: 'feed', id: 'feed' });
  blocks.push(feed);

  const ta = el('textarea', {
    class: 'textarea', id: 'msg',
    placeholder: started ? 'Ответ агенту: «ок», правки, вопрос…' : 'Пожелание к старту (необязательно)',
    onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); },
  });
  const send = async (text) => {
    const msg = text ?? ta.value.trim();
    if (started && !msg) return;
    try {
      await api(`/tasks/${t.id}/agent`, { method: 'POST', body: { message: msg } });
      ta.value = '';
      await refreshTask();
    } catch (e) { toast(e.message, true); }
  };

  const genReady = t.route !== 'generator' || t.gen?.state === 'done';
  const foot = el('div', { class: 'panel-foot composer' },
    running
      ? el('div', { class: 'row between' },
        el('div', { class: 'typing' }, 'Агент работает…'),
        el('button', { class: 'btn danger', onclick: () => api(`/tasks/${t.id}/stop`, { method: 'POST' }).then(refreshTask) }, 'Стоп'))
      : null,
    !running && started && el('div', { class: 'quick' },
      el('button', { class: 'btn', onclick: () => send('ок') }, 'Спека ок'),
      el('button', { class: 'btn', onclick: () => send('Продолжай.') }, 'Продолжай'),
      el('button', { class: 'btn', onclick: () => send('Покажи, что получилось сейчас: кадры и где файл.') }, 'Покажи итог')),
    !running && ta,
    !running && (started
      ? el('button', { class: 'btn primary', onclick: () => send() }, 'Отправить  ⌘↵')
      : el('button', { class: 'btn primary big', disabled: !genReady, onclick: () => send(ta.value.trim()) },
        t.route === 'generator' ? 'Отдать агенту: довести и выдать' : 'Запустить агента')),
  );

  panel.replaceChildren(head, el('div', { class: 'panel-scroll', id: 'task-scroll' }, ...blocks), foot);
  renderFeed(true);
}

function genCard(t) {
  const g = t.gen;
  const st = g?.state;
  const badge = {
    queued: ['run', 'в очереди'], running: ['run', 'генерирует'], done: ['done', 'готово'], error: ['err', 'ошибка'],
  }[st] || ['', 'не запускали'];
  const d = S.genDraft ||= { model: 'tripo3d/p2/image-to-3d', texture: false, detail: null };
  const busy = st === 'queued' || st === 'running';
  const price = (() => { const m = genMeta(d.model); return m ? (d.texture ? m.priceTex : m.price) : 0; })();
  const card = el('div', { class: 'card' },
    el('div', { class: 'card-h' }, g?.label || 'Генератор', el('span', { class: 'badge ' + badge[0] }, badge[1])),
    st === 'error' && el('div', { class: 'ev error' }, g.error),
    g?.files?.length && el('div', { class: 'muted' }, 'Файлы: ', ...g.files.filter((f) => /\.(glb|fbx|obj)$/i.test(f))
      .map((f) => el('a', { href: '#', 'data-file': f, style: 'margin-right:8px' }, base(f)))),
  );
  if (!busy) {
    const box = el('div', {});
    const draw = () => box.replaceChildren(
      genBlock(d, (p) => { Object.assign(d, p); draw(); }),
      el('button', {
        class: 'btn accent wide', style: 'margin-top:10px',
        onclick: async () => {
          const m = genMeta(d.model);
          if (!confirm(`Запустить ${m.label} за ${money(price)}? Деньги спишутся с fal.`)) return;
          try { await api(`/tasks/${t.id}/generate`, { method: 'POST', body: d }); await refreshTask(); } catch (e) { toast(e.message, true); }
        },
      }, `${st === 'done' ? 'Ещё вариант' : 'Сгенерировать'} · ${money(price)}`));
    draw();
    if (st === 'done') card.append(el('details', {}, el('summary', { class: 'muted' }, 'Сгенерировать ещё вариант'), box));
    else card.append(box);
  }
  return card;
}

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
      if (!group) {
        group = { start: i, items: [] };
        nodes.push(group);
      }
      group.items.push(ev.text);
      return;
    }
    group = null;
    nodes.push(ev);
  });
  feed.replaceChildren(...nodes.map((n) => {
    if (n.items) {
      const det = el('details', { class: 'tools', open: S.openGroups.has(n.start) },
        el('summary', {}, `${n.items.length === 1 ? 'действие' : n.items.length + ' действ.'}: ${n.items[n.items.length - 1]}`),
        ...n.items.map((x) => el('div', { class: 'tl', title: x }, x)));
      det.addEventListener('toggle', () => (det.open ? S.openGroups.add(n.start) : S.openGroups.delete(n.start)));
      return det;
    }
    switch (n.kind) {
      case 'text': return el('div', { class: 'ev text', html: md(n.text) });
      case 'user': return el('div', { class: 'ev user' }, n.text);
      case 'result': return el('div', { class: 'ev result' + (n.error ? ' err' : '') }, n.text);
      case 'error': return el('div', { class: 'ev error' }, n.text);
      case 'gen': return el('div', { class: 'ev gen' }, n.text);
      default: return el('div', { class: 'ev sys' }, n.text);
    }
  }));
  if (atBottom) scroller.scrollTop = scroller.scrollHeight;
}

async function patch(body) {
  try {
    S.task = await api(`/tasks/${S.sel}`, { method: 'PATCH', body });
    renderTaskPanel();
    refreshTasks();
  } catch (e) { toast(e.message, true); }
}

function renderPanel() {
  if (S.sel && S.task) renderTaskPanel();
  else renderNewForm();
}

// ── низ: этапы, кадры, выдача ─────────────────────────────────────────────
function renderDock() {
  const t = S.task;
  $('#dock').hidden = !t;
  if (!t) return;

  const rows = t.pipe?.stages || [];
  $('#stages').replaceChildren(...S.meta.stages.map((s) => {
    const r = rows.find((x) => x.n === s.n) || { state: 'pending', note: '' };
    const mark = { done: '✓', running: '▸', skipped: '–' }[r.state] || s.n;
    let time = '';
    if (r.started_at) {
      const end = r.finished_at || Date.now() / 1000;
      const sec = Math.max(0, Math.round(end - r.started_at));
      time = sec >= 60 ? `${Math.floor(sec / 60)} мин` : `${sec} с`;
    }
    return el('div', { class: `st ${r.state}${s.gate ? ' gate' : ''}`, title: r.note || s.title },
      el('div', { class: 'h' }, el('span', { class: 'mark' }, mark), s.short),
      el('div', { class: 'n' }, r.note || (r.state === 'running' ? time : r.state === 'pending' ? 'ждёт' : time)));
  }));

  const frames = t.media?.frames || [];
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
  const t = S.task;
  const box = $('#outputs');
  if (!t) { box.replaceChildren(); return; }
  const items = (t.media?.models || []).map((m) => el('span', {
    class: 'out' + (m.path === S.shown ? ' sel' : ''), title: m.path,
    onclick: (e) => { if (e.target.tagName !== 'A') showModel(m.path, { manual: true }); },
  }, base(m.path), el('a', { href: fileUrl(m.path, true), title: 'Скачать' }, '↓')));
  if (t.media?.blend) {
    items.push(el('span', { class: 'out', title: t.media.blend }, base(t.media.blend),
      el('a', { href: fileUrl(t.media.blend, true), title: 'Скачать' }, '↓')));
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
  renderTasks();
  if (!id) {
    renderPanel();
    renderDock();
    return;
  }
  await refreshTask(true);
}

let lastPanelKey = '';

async function refreshTask(first = false) {
  if (!S.sel) return;
  const id = S.sel;
  const [t, ev] = await Promise.all([
    api(`/tasks/${id}`),
    api(`/tasks/${id}/events?after=${S.eventsTotal}`),
  ]);
  if (S.sel !== id) return;
  S.task = t;
  const hadNew = ev.events.length > 0;
  S.events.push(...ev.events);
  S.eventsTotal = ev.total;

  // Панель перерисовываем целиком только когда поменялось её устройство —
  // иначе опрос сбрасывал бы набранный текст.
  const panelKey = JSON.stringify([t.running, t.agent, t.state, t.gen?.state, t.gen?.files, t.media?.spec, t.spent_usd, t.limit5h]);
  if (first || panelKey !== lastPanelKey) {
    const draft = $('#msg')?.value;
    lastPanelKey = panelKey;
    renderTaskPanel();
    if (draft && $('#msg')) $('#msg').value = draft;
  } else if (hadNew) {
    renderFeed();
  }
  renderDock();

  // Новая модель задачи — сразу в окно, пока владелец сам ничего не выбрал.
  const newest = t.media?.models?.[0]?.path;
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
$('#open-settings').addEventListener('click', () => openSettings());
$('#blender').addEventListener('click', () => { if (!$('#blender').classList.contains('on')) openSettings('blender'); });

// После настроек: другая папка — другие задачи и модели.
setOnChange(async () => {
  await refreshHealth().catch(() => {});
  renderHealth();
  await Promise.all([refreshTasks(), refreshLibrary(), renderBlender()]).catch(() => {});
  if (!S.sel) renderPanel();
});

function renderHealth() {
  const todo = blockers();
  const b = $('#open-settings');
  b.classList.toggle('warn', todo.length > 0);
  b.title = todo.length ? 'Не настроено: ' + todo.join(', ') : 'Настройки';
}

async function boot() {
  S.meta = await api('/meta');
  $('#version').textContent = 'v' + S.meta.version;
  await refreshHealth();
  renderHealth();
  await Promise.all([refreshTasks(), refreshLibrary(), renderBlender()]);
  const running = S.tasks.find((t) => t.agent_state === 'running');
  if (running) await selectTask(running.id);
  else renderPanel();
  // Первый запуск — окно приветствия с настройкой по шагам; потом, если
  // что-то отвалилось (удалили Blender, вышли из Claude), — сразу настройки.
  const settings = await api('/settings');
  const refresh = async () => {
    await refreshHealth().catch(() => {});
    renderHealth();
    await Promise.all([refreshTasks(), refreshLibrary(), renderBlender()]).catch(() => {});
    if (!S.sel) renderPanel();
  };
  if (!settings.onboarded) openWelcome({ onDone: refresh });
  else if (blockers().length) openSettings();
  // Ссылка вида #model=out/<папка>/<файл>.glb открывает модель сразу.
  const deep = new URLSearchParams(location.hash.slice(1)).get('model');
  if (deep) showModel(deep, { manual: true });

  setInterval(() => { refreshTask().catch(() => {}); }, 1500);
  setInterval(() => { refreshTasks().catch(() => {}); }, 3000);
  setInterval(() => { refreshLibrary().catch(() => {}); renderBlender(); refreshHealth().then(renderHealth, () => {}); }, 8000);
}

boot().catch((e) => toast('3DModelist не поднялся: ' + e.message, true));
