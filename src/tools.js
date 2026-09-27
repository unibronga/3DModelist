// Инструменты окна модели — колонка справа, как в Tripo Studio:
//   референс поверх окна (двигается, тянется за угол, прозрачность, масштаб);
//   части модели (скрыть, выбрать, двойной щелчок — в кадр);
//   ракурсы как в листе агента; пол с сеткой в метрах; человек 1,8 м; свет.
// Состояние вида (сетка, человек, свет) помнит браузер: это удобство человека.

import { el } from './ui.js';
import { t, num } from './i18n.js';

const ICONS = {
  ref: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>',
  parts: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
  views: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>',
  grid: '<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/><rect x="3" y="3" width="18" height="18" rx="2"/>',
  human: '<circle cx="12" cy="4.5" r="2"/><path d="M12 7v7M8 10h8M12 14l-3 7M12 14l3 7"/>',
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
};
const icon = (name) => el('span', { class: 'rail-ico', html: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` });

// Слой инструментов живёт в масштабе интерфейса (zoom = --ui), а мышь — в
// точках окна: сдвиги мыши делим на масштаб.
const uiScale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;

const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem('modelist.view.' + k)); return v ?? d; } catch { return d; } };
const keep = (k, v) => { try { localStorage.setItem('modelist.view.' + k, JSON.stringify(v)); } catch { /* приватный режим */ } };

export class Tools {
  // refs() — адреса картинок референса текущей задачи (пусто — нечего показать).
  // history — версии и готовые файлы задачи: items(), shown(), pick(item),
  // restore(n), busy() — даёт main.js.
  constructor(viewer, host, { refs = () => [], history = null, onChange = () => {} } = {}) {
    this.viewer = viewer;
    this.host = host;
    this.refs = refs;
    this.history = history;
    this.onChange = onChange;
    this.open = null;                   // открытое окошко: views | light
    this.state = {
      ref: false, parts: false, history: false,
      grid: load('grid', false), human: load('human', false),
      light: load('light', { power: 1, angle: 0 }), spin: false,
    };
    this.refIdx = 0;
    this.refView = { k: 1, x: 0, y: 0 };
    this.refOpacity = load('refOpacity', 1);
    this.refBox = load('refBox', { left: 14, top: 110, width: 300, height: 360 });   // ниже строки вида и размеров
    this.refThrough = load('refThrough', false);
    this.refFull = null;              // прежнее место окна, пока оно развёрнуто на всё поле

    this.rail = el('div', { class: 'rail' });
    this.pop = el('div', { class: 'rail-pop', hidden: true });
    this.refPanel = el('div', { class: 'refpanel', hidden: true });
    this.partsPanel = el('div', { class: 'partspanel', hidden: true });
    this.histPanel = el('div', { class: 'partspanel histpanel', hidden: true });
    this.layer = el('div', { class: 'tools-layer' }, this.rail, this.pop, this.refPanel, this.partsPanel, this.histPanel);
    host.append(this.layer);

    viewer.setLight(this.state.light);
    viewer.onParts = () => { if (this.state.parts) this.drawParts(); };
    document.addEventListener('pointerdown', (e) => {
      if (this.open && !this.pop.contains(e.target) && !this.rail.contains(e.target)) { this.open = null; this.render(); }
    });
    this.render();
  }

  // Модель загрузилась — пол и человек встают под её размер.
  modelLoaded() {
    this.viewer.setGrid(this.state.grid);
    this.viewer.setHuman(this.state.human);
  }

  toggle(name, on = !this.state[name]) {
    this.state[name] = on;
    // Части и история стоят на одном месте — открыта одна из двух.
    if (on && name === 'parts') this.state.history = false;
    if (on && name === 'history') this.state.parts = false;
    this.open = null;                   // окошко ракурсов/света закрывается при любом другом инструменте
    if (name === 'grid') { this.viewer.setGrid(on); keep('grid', on); }
    if (name === 'human') { this.viewer.setHuman(on); keep('human', on); }
    if (name === 'ref') { this.refIdx = Math.min(this.refIdx, Math.max(0, this.refs().length - 1)); }
    this.render();
    this.onChange();
  }

  render() {
    const hasRefs = this.refs().length > 0;
    const b = (name, title, on, onclick, disabled = false) => el('button', {
      class: 'rail-btn' + (on ? ' on' : ''), title, disabled, onclick,
    }, icon(name));
    this.rail.replaceChildren(
      b('ref', hasRefs ? t('rail.ref') : t('ref.none'), this.state.ref, () => this.toggle('ref'), !hasRefs),
      b('parts', t('rail.parts'), this.state.parts, () => this.toggle('parts')),
      b('history', t('hist.hint'), this.state.history, () => this.toggle('history')),
      el('div', { class: 'rail-sep' }),
      b('views', t('rail.views'), this.open === 'views', () => { this.open = this.open === 'views' ? null : 'views'; this.render(); }),
      b('grid', t('rail.grid'), this.state.grid, () => this.toggle('grid')),
      b('human', t('rail.human'), this.state.human, () => this.toggle('human')),
      b('light', t('rail.light'), this.open === 'light', () => { this.open = this.open === 'light' ? null : 'light'; this.render(); }),
    );
    this.drawPop();
    this.drawRef();
    this.partsPanel.hidden = !this.state.parts;
    if (this.state.parts) this.drawParts();
    this.renderHistory();
  }

  // ── история модели: версии и готовые файлы задачи, новые сверху ─────────
  renderHistory() {
    const h = this.history;
    this.histPanel.hidden = !this.state.history || !h;
    if (this.histPanel.hidden) return;
    const items = h.items();
    const shown = h.shown();
    const newestVer = items.find((x) => x.version != null);
    const cur = items.find((x) => x.path === shown);
    const old = cur && cur.version != null && newestVer && cur.version !== newestVer.version;
    const key = JSON.stringify([items.map((x) => x.key + x.t), shown, h.busy()]);
    if (key === this.histKey) return;
    this.histKey = key;
    this.histPanel.replaceChildren(...[
      el('div', { class: 'parts-head' },
        el('span', { class: 'pop-title' }, t('hist.title')),
        el('button', { class: 'icon-mini', title: t('common.close'), onclick: () => this.toggle('history', false) }, '✕')),
      items.length
        ? el('div', { class: 'parts-list' }, ...items.map((x) => el('div', {
          class: 'hist' + (x.path === shown ? ' on' : ''),
          onclick: () => h.pick(x),
        },
        el('div', { class: 'hist-thumb', style: x.thumb ? `background-image:url("${x.thumbUrl}")` : '' }),
        el('div', { class: 'hist-body' }, el('div', { class: 'hist-t' }, x.title), el('div', { class: 'hist-s' }, x.sub)))))
        : el('div', { class: 'muted hist-empty' }, t('hist.empty')),
      old && el('div', { class: 'hist-actions' },
        el('button', { class: 'btn primary', disabled: h.busy(), title: t('ver.restore.hint'), onclick: () => h.restore(cur.version) }, t('ver.restore', { n: cur.version })),
        el('button', { class: 'btn ghost', onclick: () => h.pick(newestVer) }, t('ver.latest') + ' ›')),
    ].filter(Boolean));
  }

  // ── ракурсы и свет — окошко слева от кнопки ─────────────────────────────
  drawPop() {
    this.pop.hidden = !this.open;
    if (!this.open) return;
    const btn = this.rail.querySelectorAll('.rail-btn')[this.open === 'views' ? 3 : 6];
    this.pop.style.top = this.rail.offsetTop + (btn?.offsetTop || 0) + 'px';
    if (this.open === 'views') {
      const v = (name) => el('button', { class: 'btn', onclick: () => this.viewer.setView(name) }, t('view.' + name));
      this.pop.replaceChildren(el('div', { class: 'pop-title' }, t('rail.views')),
        el('div', { class: 'views-grid' }, v('front'), v('back'), v('left'), v('right'), v('top'), v('q34')));
      return;
    }
    const L = this.state.light;
    const slider = (label, min, max, step, value, fmt, set) => {
      const out = el('span', { class: 'muted' }, fmt(value));
      return el('label', { class: 'pop-row' }, el('span', {}, label),
        el('input', { type: 'range', class: 'range', min, max, step, value, oninput: (e) => { const x = Number(e.target.value); out.textContent = fmt(x); set(x); } }),
        out);
    };
    const setL = (p) => { Object.assign(L, p); this.viewer.setLight(L); keep('light', L); };
    this.pop.replaceChildren(el('div', { class: 'pop-title' }, t('rail.light')),
      slider(t('light.power'), 0.3, 2, 0.05, L.power, (x) => Math.round(x * 100) + '%', (x) => setL({ power: x })),
      slider(t('light.angle'), 0, 360, 5, L.angle, (x) => x + '°', (x) => setL({ angle: x })),
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: this.state.spin, onchange: (e) => { this.state.spin = e.target.checked; this.viewer.setSpin(this.state.spin); } }),
        el('span', {}, t('light.spin'))),
      el('button', { class: 'btn ghost', onclick: () => { setL({ power: 1, angle: 0 }); this.drawPop(); } }, t('light.reset')));
  }

  // ── референс поверх окна ────────────────────────────────────────────────
  // Прозрачность убирает и подложку: модель видна сквозь картинку. «Сквозь
  // картинку» — мышь проходит к модели (крутить и приближать её под
  // референсом); выключено — мышь двигает и приближает саму картинку.
  drawRef() {
    const list = this.refs();
    const show = this.state.ref && list.length > 0;
    this.refPanel.hidden = !show;
    if (!show) return;
    const i = Math.min(this.refIdx, list.length - 1);
    this.placeRef();
    this.refPanel.classList.toggle('through', this.refThrough);
    const img = el('img', { src: list[i], draggable: 'false' });
    const stage = el('div', { class: 'ref-stage' }, img);
    const applyView = () => {
      const v = this.refView;
      img.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
      img.style.opacity = this.refOpacity;
      stage.classList.toggle('see', this.refOpacity < 0.99);
    };
    // Колесо — масштаб к курсору, перетаскивание — сдвиг, двойной щелчок — сброс.
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const v = this.refView;
      const r = stage.getBoundingClientRect();
      const k = uiScale();
      const cx = (e.clientX - r.left - r.width / 2) / k;
      const cy = (e.clientY - r.top - r.height / 2) / k;
      const k2 = Math.min(8, Math.max(0.3, v.k * Math.exp(-e.deltaY * 0.0015)));
      v.x = cx - (cx - v.x) * (k2 / v.k);
      v.y = cy - (cy - v.y) * (k2 / v.k);
      v.k = k2;
      applyView();
    }, { passive: false });
    drag(stage, (dx, dy) => { this.refView.x += dx; this.refView.y += dy; applyView(); });
    stage.addEventListener('dblclick', () => { this.refView = { k: 1, x: 0, y: 0 }; applyView(); });

    const go = (d) => { this.refIdx = (i + d + list.length) % list.length; this.refView = { k: 1, x: 0, y: 0 }; this.drawRef(); };
    const head = el('div', { class: 'ref-head' },
      el('span', { class: 'ref-title' }, t('ref.title'), list.length > 1 ? ` · ${i + 1}/${list.length}` : ''),
      list.length > 1 && el('button', { class: 'icon-mini', title: '←', onclick: () => go(-1) }, '‹'),
      list.length > 1 && el('button', { class: 'icon-mini', title: '→', onclick: () => go(1) }, '›'),
      el('button', { class: 'icon-mini', title: this.refFull ? t('ref.restore') : t('ref.full'), onclick: () => this.toggleRefFull() }, this.refFull ? '⤡' : '⤢'),
      el('button', { class: 'icon-mini', title: t('common.close'), onclick: () => this.toggle('ref', false) }, '✕'));
    drag(head, (dx, dy) => {
      this.refBox.left = Math.max(0, this.refBox.left + dx);
      this.refBox.top = Math.max(0, this.refBox.top + dy);
      this.placeRef();
    }, () => this.saveRefBox());
    const foot = el('div', { class: 'ref-foot' },
      el('label', { class: 'ref-op', title: t('ref.opacity.hint') },
        el('span', {}, t('ref.opacity')),
        el('input', { type: 'range', class: 'range', min: 0.1, max: 1, step: 0.05, value: this.refOpacity,
          oninput: (e) => { this.refOpacity = Number(e.target.value); applyView(); keep('refOpacity', this.refOpacity); } })),
      el('label', { class: 'check ref-through', title: t('ref.through.hint') },
        el('input', { type: 'checkbox', checked: this.refThrough, onchange: (e) => {
          this.refThrough = e.target.checked;
          keep('refThrough', this.refThrough);
          this.refPanel.classList.toggle('through', this.refThrough);
        } }),
        el('span', {}, t('ref.through'))));
    // Уголок справа внизу — тянуть размер; окно можно растянуть на всё поле модели.
    const grip = el('div', { class: 'ref-grip', title: t('ref.resize') });
    drag(grip, (dx, dy) => {
      const L = this.layer;
      this.refBox.width = Math.max(200, Math.min(L.clientWidth - this.refBox.left, this.refBox.width + dx));
      this.refBox.height = Math.max(180, Math.min(L.clientHeight - this.refBox.top, this.refBox.height + dy));
      this.placeRef();
    }, () => this.saveRefBox());
    this.refPanel.replaceChildren(head, stage, foot, grip);
    applyView();
  }

  placeRef() {
    Object.assign(this.refPanel.style, {
      left: this.refBox.left + 'px', top: this.refBox.top + 'px',
      width: this.refBox.width + 'px', height: this.refBox.height + 'px',
    });
  }

  // На всё поле модели (под строкой вида, левее колонки инструментов) и обратно.
  toggleRefFull() {
    if (this.refFull) {
      this.refBox = this.refFull;
      this.refFull = null;
    } else {
      this.refFull = { ...this.refBox };
      const L = this.layer;
      this.refBox = { left: 8, top: 56, width: L.clientWidth - 8 - 60, height: L.clientHeight - 56 - 8 };
    }
    this.drawRef();
  }

  // Помним обычный размер и место, а не «на всё поле».
  saveRefBox() {
    this.refFull = null;
    keep('refBox', this.refBox);
    this.drawRef();
  }

  // ── части модели ────────────────────────────────────────────────────────
  drawParts() {
    const parts = this.viewer.parts();
    const v = this.viewer;
    const eye = (hidden) => el('span', { class: 'eye' + (hidden ? ' off' : ''), html: hidden
      ? '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 9.5 7 9.5 7a15 15 0 0 1-3 3.8M6.2 6.3C3.8 8 2.5 12 2.5 12S6 19 12 19c1.6 0 3-.4 4.3-1"/></svg>'
      : '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z"/><circle cx="12" cy="12" r="2.8"/></svg>' });
    const sel = parts.find((p) => p.key === v.picked);
    this.partsPanel.replaceChildren(...[
      el('div', { class: 'parts-head' },
        el('span', { class: 'pop-title' }, t('parts.title', { n: parts.length })),
        v.hidden.size > 0 && el('button', { class: 'link-btn', onclick: () => v.showAll() }, t('parts.showAll')),
        el('button', { class: 'icon-mini', title: t('common.close'), onclick: () => this.toggle('parts', false) }, '✕')),
      parts.length
        ? el('div', { class: 'parts-list' }, ...parts.map((p) => {
          const hidden = v.hidden.has(p.key);
          return el('div', {
            class: 'part' + (p.key === v.picked ? ' on' : '') + (hidden ? ' off' : ''),
            title: t('parts.hint'),
            onclick: (e) => { if (!e.target.closest('.eye-btn')) v.selectPart(p.key); },
            ondblclick: (e) => { if (!e.target.closest('.eye-btn')) v.framePart(p.key); },
            onmouseenter: () => v.hover(p.meshes[0]),
            onmouseleave: () => v.hover(null),
          },
          el('button', { class: 'eye-btn', title: hidden ? t('parts.show') : t('parts.hide'), onclick: () => v.setPartHidden(p.key, !hidden) }, eye(hidden)),
          el('span', { class: 'part-name' }, p.name),
          el('span', { class: 'part-tris' }, num(Math.round(p.tris))));
        }))
        : el('div', { class: 'muted' }, t('parts.empty')),
      sel && el('div', { class: 'part-sel' },
        el('b', {}, sel.name),
        el('div', {}, t('parts.size', { size: sel.size.map((x) => x.toFixed(2)).join(' × ') })),
        el('div', {}, t('parts.tris', { n: num(Math.round(sel.tris)) }))),
    ].filter(Boolean));
  }
}

// Перетаскивание мышью: onMove(dx, dy) на каждый шаг, onEnd — по отпусканию.
function drag(node, onMove, onEnd = () => {}) {
  node.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    e.preventDefault();
    let x = e.clientX;
    let y = e.clientY;
    node.setPointerCapture(e.pointerId);
    const k = uiScale();
    const move = (ev) => { onMove((ev.clientX - x) / k, (ev.clientY - y) / k); x = ev.clientX; y = ev.clientY; };
    const up = () => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); onEnd(); };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
  });
}
