// «Улучшить модель» — блок правой панели готовой модели (владелец 09.10):
// проверка, нормали, починка дыр и швов, мусор, меньше граней, ретопология,
// огранка. Каждый шаг считает Blender без окна над копией (server/fix.mjs);
// пока считает — модель «сканируется» в окне. Шаги копятся, последний можно
// отменить; «Сохранить как новую модель» кладёт результат в out/ отдельной
// моделью, исходник не трогается.

import { $, el, api, toast, errText, segment } from './ui.js';
import { t, num } from './i18n.js';

const svg = (d) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const OPS = {
  check: svg('<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'),
  normals: svg('<path d="M4 18h16"/><path d="M12 18V6"/><path d="M8.5 9.5L12 6l3.5 3.5"/>'),
  repair: svg('<path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-3-3 2.5-2.5z"/>'),
  cleanup: svg('<path d="M4 20l6-6M14 4l6 6-8 8-6-6 8-8z"/><path d="M3 21h6"/>'),
  decimate: svg('<path d="M12 3l9 16H3L12 3z"/><path d="M7.5 11h9"/>'),
  retopo: svg('<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 10h16M4 15h16M10 4v16M15 4v16"/>'),
  shade: svg('<path d="M12 3l8 5v8l-8 5-8-5V8l8-5z"/><path d="M12 3v18M4 8l8 5 8-5"/>'),
};
const PARAM_OPS = new Set(['decimate', 'retopo', 'shade']);

const trisOf = (root) => {
  let n = 0;
  root?.traverse((o) => { if (o.isMesh) { const g = o.geometry; n += g.index ? g.index.count / 3 : g.attributes.position.count / 3; } });
  return Math.round(n);
};

export class Fixer {
  // show(path) — открыть файл в окне, не трогая камеру; saved(name) — модель
  // сохранена, выбрать её в списке; rerender() — перерисовать панель;
  // canRun() — есть ли Blender.
  constructor(viewer, { show, saved, rerender, canRun }) {
    Object.assign(this, { viewer, show, saved, rerender, canRun });
    this.reset(null);
  }

  reset(model, src = null) {
    if (this.sid) api('/fix/drop', { method: 'POST', body: { sid: this.sid } }).catch(() => {});
    Object.assign(this, { model, src, sid: null, steps: [], report: null, busy: null, open: null, name: model ? model + '_fix' : '', opts: { shade: 'flat' } });
  }

  // Выбрана другая модель — прежняя правка сбрасывается.
  sync(model, src) {
    if (model !== this.model || (!this.steps.length && src !== this.src)) this.reset(model, src);
  }

  // Модель для показа: последний шаг, иначе исходник.
  current() { return this.steps.length ? this.steps[this.steps.length - 1].file : this.src; }
  edited() { return this.steps.length > 0; }

  async run(op, params = {}) {
    if (this.busy) return;
    this.busy = op;
    this.rerender();
    const label = el('div', { class: 'scan-label' }, el('span', { class: 'scan-dot' }), t('fix.busy.' + op));
    $('#viewport').append(label);
    this.viewer.scan(true);
    try {
      const r = await api('/fix', { method: 'POST', body: { sid: this.sid, src: this.src, op, params } });
      this.sid = r.sid;
      if (op === 'check') this.report = r.report;
      else {
        this.steps = r.steps;
        this.report = null;
        this.open = null;
      }
    } catch (e) { toast(errText(e), true); }
    this.viewer.scan(false);
    label.remove();
    this.busy = null;
    if (op !== 'check' && this.steps.length) await this.show(this.current());
    this.rerender();
  }

  async undo() {
    if (!this.sid || this.busy) return;
    try {
      const r = await api('/fix/undo', { method: 'POST', body: { sid: this.sid } });
      this.steps = r.steps;
      this.report = null;
      await this.show(this.current());
    } catch (e) { toast(errText(e), true); }
    this.rerender();
  }

  async revert() {
    if (this.busy) return;
    const { model, src } = this;
    this.reset(model, src);
    await this.show(src);
    this.rerender();
  }

  async save() {
    if (!this.sid || this.busy) return;
    // Превью для списка — кадр окна как есть.
    let thumb = null;
    try { this.viewer.renderer.render(this.viewer.scene, this.viewer.camera); thumb = this.viewer.renderer.domElement.toDataURL('image/png'); } catch { /* без превью */ }
    try {
      const r = await api('/fix/save', { method: 'POST', body: { sid: this.sid, name: this.name, thumb } });
      this.sid = null;
      this.reset(null);
      toast(t('fix.saved', { name: r.name }));
      await this.saved(r.name, r.file);
    } catch (e) { toast(errText(e), true); }
  }

  panel() {
    const busy = !!this.busy;
    const can = this.canRun();
    const cur = this.steps.length ? this.steps[this.steps.length - 1].tris : trisOf(this.viewer.root);
    const btn = (op) => el('button', {
      class: 'fix-btn' + (this.open === op ? ' on' : '') + (this.busy === op ? ' run' : ''),
      disabled: busy || !can, title: t('tip.fix.' + op),
      onclick: () => {
        if (PARAM_OPS.has(op)) { this.open = this.open === op ? null : op; this.rerender(); return; }
        this.run(op);
      },
    }, el('span', { class: 'fix-ico', html: OPS[op] }), el('span', {}, t('fix.op.' + op)));

    return el('div', { class: 'field fix-field' },
      el('div', { class: 'label' }, t('fix.title'), el('span', { class: 'hint' }, t('fix.hint'))),
      !can && el('div', { class: 'muted' }, t('fix.noBlender')),
      el('div', { class: 'fix-grid' }, ...Object.keys(OPS).map(btn)),
      this.open && this.options(this.open, cur, busy),
      this.report && this.reportCard(),
      this.steps.length > 0 && this.stepsCard(busy));
  }

  // Ползунок граней / выбор огранки — под кнопкой, с «Применить».
  options(op, cur, busy) {
    let body;
    if (op === 'shade') {
      body = segment([['flat', t('fix.shade.flat'), t('tip.fix.shade.flat')], ['smooth', t('fix.shade.smooth'), t('tip.fix.shade.smooth')]],
        this.opts.shade, (v) => { this.opts.shade = v; this.rerender(); }, 'full');
    } else {
      const min = Math.max(100, Math.round(cur * 0.05));
      const max = op === 'retopo' ? Math.max(min + 100, Math.round(cur * 1.5)) : Math.max(min + 1, cur);
      const def = op === 'retopo' ? cur : Math.round(cur / 2);
      const v = Math.min(max, Math.max(min, this.opts[op] ?? def));
      this.opts[op] = v;
      const out = el('span', { class: 'hint' }, t('fix.tris', { n: num(v) }));
      body = el('div', { class: 'field' },
        el('div', { class: 'label' }, t('fix.target'), out),
        el('input', {
          class: 'range', type: 'range', min, max, step: Math.max(10, Math.round((max - min) / 200)), value: v,
          oninput: (e) => { this.opts[op] = Number(e.target.value); out.textContent = t('fix.tris', { n: num(this.opts[op]) }); },
        }),
        el('div', { class: 'muted' }, t('fix.now', { n: num(cur) })));
    }
    const params = op === 'shade' ? { mode: this.opts.shade } : { target: this.opts[op] };
    return el('div', { class: 'fix-opts' },
      el('div', { class: 'muted' }, t('fix.about.' + op)),
      body,
      el('button', { class: 'btn primary', disabled: busy, title: t('tip.fix.apply'), onclick: () => this.run(op, params) }, t('fix.apply')));
  }

  reportCard() {
    const r = this.report;
    const row = (key, n, fix) => el('div', { class: 'chk ' + (n ? 'bad' : 'ok') },
      el('span', { class: 'chk-mark' }, n ? '!' : '✓'),
      el('span', {}, t('fix.rep.' + key, { n: num(n) }), n && fix ? el('span', { class: 'muted' }, ' → ' + t('fix.op.' + fix)) : null));
    const bad = r.holes + r.flipped + r.loose + r.junk + r.nonmanifold;
    return el('div', { class: 'fix-report' },
      el('div', { class: 'muted' }, t('fix.rep.head', { tris: num(r.tris), parts: num(r.parts) })),
      row('holes', r.holes, 'repair'),
      row('flipped', r.flipped, 'normals'),
      row('loose', r.loose, 'repair'),
      row('junk', r.junk, 'cleanup'),
      row('nonmanifold', r.nonmanifold, null),
      // Крупные открытые края — вырезы одежды генератора, не дефект: только справка.
      r.openings > 0 && el('div', { class: 'muted' }, t('fix.rep.openings', { n: num(r.openings) })),
      !bad && el('div', { class: 'muted' }, t('fix.rep.clean')));
  }

  stepsCard(busy) {
    const first = this.steps[0].before;
    const last = this.steps[this.steps.length - 1];
    const nameInput = el('input', { class: 'input', value: this.name, placeholder: t('fix.name.ph'), oninput: (e) => { this.name = e.target.value; } });
    return el('div', { class: 'fix-steps' },
      el('div', { class: 'label' }, t('fix.steps'), el('span', { class: 'hint' }, t('fix.trisChange', { a: num(first), b: num(last.tris) }))),
      el('ol', { class: 'fix-list' }, ...this.steps.map((s) => { const n = stepNote(s); return el('li', {}, t('fix.op.' + s.op), n && el('span', { class: 'muted' }, ' · ' + n)); })),
      el('div', { class: 'row' },
        el('button', { class: 'btn', disabled: busy, title: t('tip.fix.undo'), onclick: () => this.undo() }, t('fix.undo')),
        el('button', { class: 'btn ghost', disabled: busy, title: t('tip.fix.revert'), onclick: () => this.revert() }, t('fix.revert'))),
      el('div', { class: 'field' },
        el('div', { class: 'label' }, t('fix.name')),
        nameInput,
        el('button', { class: 'btn accent wide', disabled: busy, title: t('tip.fix.save'), onclick: () => this.save() }, t('fix.save'))));
  }
}

// Что сделал шаг — короткой припиской.
function stepNote(s) {
  const d = s.done || {};
  if (s.op === 'normals') return t('fix.did.normals', { n: num(d.flipped || 0) });
  if (s.op === 'repair') return t('fix.did.repair', { holes: num(d.holes || 0), loose: num(d.loose || 0) });
  if (s.op === 'cleanup') return t('fix.did.cleanup', { n: num(d.junk || 0) });
  if (s.op === 'shade') return '';
  return t('fix.trisChange', { a: num(s.before), b: num(s.tris) })
    + (d.quads ? ' · ' + t('fix.did.quads', { n: num(d.quads) }) : '') + (d.voxel ? ' · ' + t('fix.did.voxel') : '');
}
