// Метки на модели. Кнопка «Метка» (или M) включает режим: часть под курсором
// подсвечивается, щелчок ставит номер, к номеру пишется замечание. Метки
// уходят агенту со следующим сообщением — с именем части, точкой и снимком
// окна (main.js). Точка хранится в координатах файла модели, поэтому метка
// стоит на месте, пока крутишь камеру и пока приходят новые версии.

import { el } from './ui.js';
import { t } from './i18n.js';

export class Pins {
  constructor(viewer, host, { context = () => ({}), onChange = () => {} } = {}) {
    this.viewer = viewer;
    this.host = host;
    this.context = context;
    this.onChange = onChange;
    this.list = [];
    this.mode = false;
    this.editing = null;

    this.layer = el('div', { class: 'pins-layer' });
    this.tip = el('div', { class: 'pin-tip', hidden: true });
    this.hint = el('div', { class: 'pin-hint', hidden: true });
    host.append(this.layer);
    this.layer.append(this.tip, this.hint);
    viewer.onFrame = () => this.place();

    const canvas = viewer.renderer.domElement;
    let down = null;
    canvas.addEventListener('pointerdown', (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
    canvas.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!this.mode || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;   // тянули — это поворот камеры
      const hit = viewer.pick(e.clientX, e.clientY);
      if (hit) this.add(hit);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.mode || e.buttons) { this.hideTip(); return; }
      const hit = viewer.pick(e.clientX, e.clientY);
      viewer.hover(hit?.mesh || null);
      if (!hit) { this.tip.hidden = true; return; }
      const r = host.getBoundingClientRect();
      this.tip.textContent = hit.part || t('pin.noPart');
      this.tip.style.left = ((e.clientX - r.left) / r.width) * 100 + '%';
      this.tip.style.top = ((e.clientY - r.top) / r.height) * 100 + '%';
      this.tip.hidden = false;
    });
    canvas.addEventListener('pointerleave', () => this.hideTip());
  }

  hideTip() {
    this.tip.hidden = true;
    this.viewer.hover(null);
  }

  setMode(on) {
    this.mode = on;
    this.host.classList.toggle('pin-mode', on);
    this.hint.textContent = t('pin.mode');
    this.hint.hidden = !on;
    if (!on) this.hideTip();
    this.onChange();
  }

  add(hit) {
    const ctx = this.context();
    const pin = { local: hit.local, part: hit.part, note: '', version: ctx.version ?? null, model: ctx.model || null };
    this.list.push(pin);
    this.open(pin);
  }

  open(pin) {
    this.editing = pin;
    this.render();
    this.onChange();
    setTimeout(() => this.layer.querySelector('.pin-pop input')?.focus(), 0);
  }

  close() {
    if (!this.editing) return;
    this.editing = null;
    this.render();
    this.onChange();
  }

  remove(pin) {
    this.list = this.list.filter((p) => p !== pin);
    if (this.editing === pin) this.editing = null;
    this.render();
    this.onChange();
  }

  clear() {
    this.list = [];
    this.editing = null;
    this.render();
    this.onChange();
  }

  render() {
    this.layer.querySelectorAll('.pin').forEach((x) => x.remove());
    this.list.forEach((pin, i) => {
      const input = pin === this.editing && el('input', {
        class: 'input', value: pin.note, placeholder: t('pin.ph'),
        oninput: (e) => { pin.note = e.target.value; this.onChange(); },
        onkeydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); this.close(); }
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
        },
      });
      const node = el('div', { class: 'pin' + (pin === this.editing ? ' open' : '') },
        el('button', { class: 'pin-n', title: pin.part || t('pin.noPart'), onclick: () => (this.editing === pin ? this.close() : this.open(pin)) }, String(i + 1)),
        input && el('div', { class: 'pin-pop' },
          el('div', { class: 'pin-part' }, pin.part || t('pin.noPart')),
          el('div', { class: 'row' }, input,
            el('button', { class: 'btn ghost danger', title: t('pin.remove'), onclick: () => this.remove(pin) }, '✕'))));
      pin.node = node;
      this.layer.append(node);
    });
    this.place();
  }

  // Каждый кадр: номер следует за точкой модели; точка за камерой — прячем.
  place() {
    for (const pin of this.list) {
      if (!pin.node) continue;
      const at = this.viewer.root ? this.viewer.project(pin.local) : null;
      pin.node.hidden = !at;
      if (!at) continue;
      pin.node.style.left = at.x * 100 + '%';
      pin.node.style.top = at.y * 100 + '%';
      pin.node.classList.toggle('flip', at.x > 0.62);      // у правого края окошко — слева от номера
    }
  }
}
