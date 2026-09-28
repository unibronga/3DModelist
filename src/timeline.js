// Полоса времени под моделью — отдельная карточка: высота тянется за верхний
// край (помнит браузер), линейка и строка «Всё тело» закреплены, строки
// костей прокручиваются. Щелчок по имени кости — выбрать её (подсветится на
// модели), двойной щелчок — переименовать. Щелчок или протяжка по полосе —
// кадр; ромбик — выбрать ключ, тянуть — перенести.

import { el } from './ui.js';
import { t } from './i18n.js';

const H_KEY = 'modelist.tl.h';
const loadH = () => { try { return Number(localStorage.getItem(H_KEY)) || 300; } catch { return 300; } };
const keepH = (h) => { try { localStorage.setItem(H_KEY, String(Math.round(h))); } catch { /* приватный режим */ } };
const uiScale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;

// Имя прямо в строке: Enter или уход фокуса — сохранить, Esc — отменить.
export function inlineRename(label, value, commit) {
  const input = el('input', { class: 'input inline-name', value });
  const done = (ok) => {
    input.onblur = null;
    label.replaceChildren(value);
    if (ok && input.value.trim() && input.value.trim() !== value) commit(input.value.trim());
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  };
  input.onblur = () => done(true);
  input.onclick = (e) => e.stopPropagation();
  label.replaceChildren(input);
  input.focus();
  input.select();
}

export class Timeline {
  // cb: onFrame(f), onSelect(key|null), onMove(bone|null, from, to), onPlay(),
  //     onKey(), onMirror(), onCopy(), onPaste(), onEase(e), onDelete(), onLoop(on),
  //     onBone(name|null), onRename(from, to)
  constructor(host, cb) {
    this.cb = cb;
    this.root = el('div', { class: 'timeline', hidden: true });
    this.root.style.height = loadH() + 'px';
    host.append(this.root);
    this.view = null;
  }

  hide() { this.root.hidden = true; this.view = null; }

  // view: { clip, frame, playing, rows:[{bone, label, depth}], sel:{bone,f}|null,
  //         bone (выбранная кость), ease (у выбранного ключа), canPaste }
  render(view) {
    this.view = view;
    const { clip, frame, playing, rows, sel } = view;
    this.root.hidden = false;
    const n = clip.frames;
    const pct = (f) => `${(f / n) * 100}%`;

    const btn = (label, title, onclick, { on = false, disabled = false } = {}) =>
      el('button', { class: 'btn tl-btn' + (on ? ' on' : ''), title, disabled, onclick }, label);
    const easeSeg = el('div', { class: 'seg tl-ease', title: t('tl.ease.hint') },
      ...['smooth', 'linear', 'step'].map((e) => el('button', {
        class: view.ease === e ? 'on' : '', disabled: !sel, title: t('tip.ease.' + e), onclick: () => this.cb.onEase(e),
      }, t('tl.ease.' + e))));
    this.frameLabel = el('span', { class: 'tl-frame' });
    const bar = el('div', { class: 'tl-bar' },
      btn(playing ? '❚❚' : '▶', t(playing ? 'tip.tl.pause' : 'tip.tl.play'), () => this.cb.onPlay(), { on: playing }),
      btn('⟲', t('tl.loop.hint'), () => this.cb.onLoop(!clip.loop), { on: clip.loop }),
      this.frameLabel,
      el('span', { class: 'tl-name' }, clip.name),
      el('span', { class: 'tl-sp' }),
      btn('◆ ' + t('tl.key'), t('tl.key.hint'), () => this.cb.onKey()),
      btn('⇋ ' + t('tl.mirror'), t('tl.mirror.hint'), () => this.cb.onMirror()),
      btn(t('tl.copy'), t('tl.copy.hint'), () => this.cb.onCopy()),
      btn(t('tl.paste'), t('tl.paste.hint'), () => this.cb.onPaste(), { disabled: !view.canPaste }),
      easeSeg,
      btn('✕', t('tl.delete.hint'), () => this.cb.onDelete(), { disabled: !sel }));

    // Линейка: метка каждые 5 кадров (у длинных — реже).
    const step = n <= 40 ? 5 : n <= 120 ? 10 : 30;
    const ruler = el('div', { class: 'tl-ruler' });
    for (let f = 0; f <= n; f += step) ruler.append(el('span', { class: 'tl-tick', style: `left:${pct(f)}` }, String(f)));

    const all = new Set();
    for (const ks of Object.values(clip.keys)) for (const k of ks) all.add(k.f);
    const lane = (bone, frames) => {
      const l = el('div', { class: 'tl-lane' + (bone && bone === view.bone ? ' cur' : '') });
      for (const f of frames) {
        const on = sel && sel.f === f && (sel.bone === bone || sel.bone === null);
        const d = el('span', { class: 'tl-key' + (bone ? '' : ' all') + (on ? ' on' : ''), style: `left:${pct(f)}` });
        d.addEventListener('pointerdown', (e) => this.keyDown(e, bone, f));
        l.append(d);
      }
      return l;
    };
    // Щелчок выбирает кость и перерисовывает полосу, поэтому двойной щелчок
    // ловим сами: второй щелчок по той же строке сразу следом — переименовать.
    const label = (r) => el('div', {
      class: 'tl-lab' + (r.bone === view.bone ? ' cur' : ''), title: t('tl.bone.hint'), 'data-bone': r.bone,
      style: `padding-left:${10 + (r.depth || 0) * 10}px`,
      onclick: () => {
        const again = this.lastClick && this.lastClick.bone === r.bone && Date.now() - this.lastClick.t < 450;
        this.lastClick = { bone: r.bone, t: Date.now() };
        if (!again) { this.cb.onBone(r.bone === view.bone ? null : r.bone); return; }
        const lab = this.root.querySelector(`.tl-lab[data-bone="${CSS.escape(r.bone)}"]`);
        if (lab) inlineRename(lab, r.bone, (to) => this.cb.onRename(r.bone, to));
      },
    }, r.label);

    // Шапка: линейка и «Всё тело» — не прокручиваются.
    this.headLine = el('div', { class: 'tl-playhead' });
    this.bodyLine = el('div', { class: 'tl-playhead' });
    const headLanes = el('div', { class: 'tl-lanes' }, ruler, lane(null, [...all]), this.headLine);
    const bodyLanes = el('div', { class: 'tl-lanes' }, ...rows.map((r) => lane(r.bone, (clip.keys[r.bone] || []).map((k) => k.f))), this.bodyLine);
    for (const lanes of [headLanes, bodyLanes]) {
      lanes.addEventListener('pointerdown', (e) => { if (!e.target.classList.contains('tl-key')) this.scrub(e); });
    }
    this.lanes = headLanes;
    const head = el('div', { class: 'tl-grid tl-top' },
      el('div', { class: 'tl-labels' }, el('div', { class: 'tl-lab ruler-lab' }), el('div', { class: 'tl-lab all' }, t('tl.all'))),
      headLanes);
    const keepScroll = this.scroller?.scrollTop || 0;
    this.scroller = el('div', { class: 'tl-scroll' },
      el('div', { class: 'tl-grid' }, el('div', { class: 'tl-labels' }, ...rows.map(label)), bodyLanes));
    const grip = el('div', { class: 'tl-grip', title: t('tl.grip.hint') });
    grip.addEventListener('pointerdown', (e) => this.resize(e));
    this.root.replaceChildren(grip, bar, head, this.scroller);
    this.scroller.scrollTop = keepScroll;
    this.setFrame(frame);
  }

  // Только бегунок и номер кадра — во время проигрывания без перерисовки.
  setFrame(f) {
    if (!this.view) return;
    const n = this.view.clip.frames;
    const left = `${(Math.min(f, n) / n) * 100}%`;
    this.headLine.style.left = left;
    this.bodyLine.style.left = left;
    this.frameLabel.textContent = t('tl.frame', { f: Math.round(f), n });
  }

  // Потянуть верхний край — выше или ниже; окно модели подстраивается само.
  resize(e) {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = this.root.getBoundingClientRect().height / uiScale();
    const max = () => (this.root.parentElement.getBoundingClientRect().height / uiScale()) * 0.75;
    const move = (ev) => {
      const h = Math.max(150, Math.min(max(), h0 - (ev.clientY - y0) / uiScale()));
      this.root.style.height = h + 'px';
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      keepH(parseFloat(this.root.style.height));
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  frameAt(e) {
    const r = this.lanes.getBoundingClientRect();
    const n = this.view.clip.frames;
    return Math.max(0, Math.min(n, Math.round(((e.clientX - r.left) / r.width) * n)));
  }

  scrub(e) {
    e.preventDefault();
    this.cb.onSelect(null);
    this.cb.onFrame(this.frameAt(e));
    const move = (ev) => this.cb.onFrame(this.frameAt(ev));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  keyDown(e, bone, f) {
    e.preventDefault();
    e.stopPropagation();
    this.cb.onSelect({ bone, f });
    this.cb.onFrame(f);
    const dot = e.target;
    let to = f;
    const move = (ev) => {
      to = this.frameAt(ev);
      dot.style.left = `${(to / this.view.clip.frames) * 100}%`;
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      if (to !== f) this.cb.onMove(bone, f, to);
    };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }
}
