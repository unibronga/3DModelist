// Строка меню вверху окна — как в 3DPainter. Меню описано данными: пункты
// дублируют кнопки панелей, и держать их одним списком проще, чем искать,
// где какой отстал.
//
// Пункт: { label, hint?, action, checked?, radio?, disabled? } или '-' (разделитель).
// label и title — функции: надписи переживают смену языка через relabel().

const text = (v) => (typeof v === 'function' ? v() : v);

export class MenuBar {
  constructor(container, menus) {
    this.container = container;
    this.menus = menus;
    this.open = -1;
    this.els = [];

    menus.forEach((m, i) => {
      const btn = document.createElement('button');
      btn.className = 'menu-title';
      btn.textContent = text(m.title);
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.toggle(i); });
      // Меню уже раскрыто — наведение перекидывает на соседнее, как в любой строке меню.
      btn.addEventListener('pointerenter', () => { if (this.open >= 0 && this.open !== i) this.show(i); });
      const drop = document.createElement('div');
      drop.className = 'menu-drop';
      container.append(btn, drop);
      this.els.push({ btn, drop });
      this.fill(i);
    });

    document.addEventListener('pointerdown', (e) => {
      if (this.open < 0) return;
      const t = e.target;
      if (!(t instanceof Node && this.els[this.open].drop.contains(t))) this.close();
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    window.addEventListener('blur', () => this.close());
  }

  fill(i) {
    const { drop } = this.els[i];
    drop.replaceChildren();
    for (const item of this.menus[i].items) {
      if (item === '-') {
        const hr = document.createElement('div');
        hr.className = 'menu-sep';
        drop.append(hr);
        continue;
      }
      const row = document.createElement('button');
      row.className = 'menu-item';
      const mark = document.createElement('span');
      mark.className = 'mark';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = text(item.label);
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = item.hint || '';
      row.append(mark, label, hint);
      row.addEventListener('pointerdown', (e) => e.stopPropagation());
      row.addEventListener('click', () => {
        if (row.classList.contains('disabled')) return;
        this.close();
        item.action();
      });
      item.row = row;
      drop.append(row);
    }
  }

  // Смена языка: тексты новые, устройство меню то же.
  relabel() {
    this.menus.forEach((m, i) => {
      this.els[i].btn.textContent = text(m.title);
      for (const item of m.items) {
        if (item !== '-' && item.row) item.row.querySelector('.label').textContent = text(item.label);
      }
    });
  }

  // Галочки и доступность — перед каждым показом.
  refresh() {
    for (const m of this.menus) {
      for (const item of m.items) {
        if (item === '-' || !item.row) continue;
        const on = item.checked ? item.checked() : item.radio ? item.radio() : false;
        item.row.classList.toggle('checked', !!on);
        item.row.querySelector('.mark').textContent = on ? (item.radio ? '•' : '✓') : '';
        item.row.classList.toggle('disabled', item.disabled ? !!item.disabled() : false);
      }
    }
  }

  show(i) {
    this.refresh();
    this.els.forEach(({ btn, drop }, k) => {
      const on = k === i;
      btn.classList.toggle('open', on);
      drop.classList.toggle('open', on);
      if (on) drop.style.left = btn.offsetLeft + 'px';
    });
    this.open = i;
  }

  toggle(i) { if (this.open === i) this.close(); else this.show(i); }

  close() {
    this.els.forEach(({ btn, drop }) => { btn.classList.remove('open'); drop.classList.remove('open'); });
    this.open = -1;
  }
}
