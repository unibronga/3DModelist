// Полоса времени под моделью: кадры, ключи костей ромбиками, бегунок.
// Щёлкнул или потянул по полосе — кадр; ромбик — выбрать ключ, тянуть —
// перенести. Строка «Всё тело» — все ключи кадра разом.

import { el } from './ui.js';
import { t } from './i18n.js';

export class Timeline {
  // cb: onFrame(f), onSelect(key|null), onMove(bone|null, from, to), onPlay(),
  //     onKey(), onMirror(), onCopy(), onPaste(), onEase(e), onDelete(), onLoop(on)
  constructor(host, cb) {
    this.cb = cb;
    this.root = el('div', { class: 'timeline', hidden: true });
    host.append(this.root);
    this.view = null;
  }

  hide() { this.root.hidden = true; this.view = null; }

  // view: { clip, frame, playing, rows:[{bone, label}], sel:{bone,f}|null,
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
        class: view.ease === e ? 'on' : '', disabled: !sel, onclick: () => this.cb.onEase(e),
      }, t('tl.ease.' + e))));
    this.frameLabel = el('span', { class: 'tl-frame' });
    const bar = el('div', { class: 'tl-bar' },
      btn(playing ? '❚❚' : '▶', t(playing ? 'tl.pause' : 'tl.play') + ' — Space', () => this.cb.onPlay(), { on: playing }),
      btn('⟲', t('tl.loop.hint'), () => this.cb.onLoop(!clip.loop), { on: clip.loop }),
      this.frameLabel,
      el('span', { class: 'tl-sp' }),
      btn('◆ ' + t('tl.key'), t('tl.key.hint'), () => this.cb.onKey()),
      btn('⇋ ' + t('tl.mirror'), t('tl.mirror.hint'), () => this.cb.onMirror()),
      btn(t('tl.copy'), t('tl.copy.hint') + ' — ⌘C', () => this.cb.onCopy()),
      btn(t('tl.paste'), t('tl.paste.hint') + ' — ⌘V', () => this.cb.onPaste(), { disabled: !view.canPaste }),
      easeSeg,
      btn('✕', t('tl.delete.hint'), () => this.cb.onDelete(), { disabled: !sel }));

    // Линейка: метка каждые 5 кадров (у длинных — реже).
    const step = n <= 40 ? 5 : n <= 120 ? 10 : 30;
    const ruler = el('div', { class: 'tl-ruler' });
    for (let f = 0; f <= n; f += step) ruler.append(el('span', { class: 'tl-tick', style: `left:${pct(f)}` }, String(f)));

    const all = new Set();
    for (const ks of Object.values(clip.keys)) for (const k of ks) all.add(k.f);
    const lane = (bone, frames) => {
      const l = el('div', { class: 'tl-lane' + (bone === view.bone ? ' cur' : '') });
      for (const f of frames) {
        const on = sel && sel.f === f && (sel.bone === bone || sel.bone === null);
        const d = el('span', { class: 'tl-key' + (bone ? '' : ' all') + (on ? ' on' : ''), style: `left:${pct(f)}` });
        d.addEventListener('pointerdown', (e) => this.keyDown(e, bone, f));
        l.append(d);
      }
      return l;
    };
    const labels = el('div', { class: 'tl-labels' },
      el('div', { class: 'tl-lab ruler-lab' }),
      el('div', { class: 'tl-lab all' }, t('tl.all')),
      ...rows.map((r) => el('div', { class: 'tl-lab' + (r.bone === view.bone ? ' cur' : '') }, r.label)));
    this.head = el('div', { class: 'tl-head' });
    const lanes = el('div', { class: 'tl-lanes' },
      ruler,
      lane(null, [...all]),
      ...rows.map((r) => lane(r.bone, (clip.keys[r.bone] || []).map((k) => k.f))),
      this.head);
    lanes.addEventListener('pointerdown', (e) => { if (!e.target.classList.contains('tl-key')) this.scrub(e); });
    this.lanes = lanes;
    this.root.replaceChildren(bar, el('div', { class: 'tl-body' }, labels, lanes));
    this.setFrame(frame);
  }

  // Только бегунок и номер кадра — во время проигрывания без перерисовки.
  setFrame(f) {
    if (!this.view) return;
    const n = this.view.clip.frames;
    this.head.style.left = `${(Math.min(f, n) / n) * 100}%`;
    this.frameLabel.textContent = t('tl.frame', { f: Math.round(f), n });
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
