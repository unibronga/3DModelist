// Подсказки — своя карточка вместо системной, как в 3DPainter: у каждой
// кнопки и элемента с подсказкой. Системный title — одна серая строка через
// секунду и где попало; здесь — карточка у элемента: название, клавиша и
// описание. Появляется после короткой паузы, а пока рука ведёт от кнопки к
// кнопке — сразу, без новой паузы.
//
// Источник — title. При наведении он переезжает в data-tip-text, иначе
// браузер показал бы и свою подсказку. Разметку переводит applyDOM(), код
// ставит title при перерисовке — свежий title всегда главнее запомненного,
// поэтому при смене языка карточка заговорит на новом.
// Формат строки: «Название: описание (клавиша)» — см. parse().

const DELAY = 380;       // мс до первого показа
const CHAIN = 700;       // мс, в течение которых следующий показ — сразу

// «Отменить правку: … (⌘Z)» → название, описание, клавиша. Клавиша — только
// если похожа на сочетание: «(0, 0, 0)» клавишей не станет.
function parse(line) {
  let title = line.trim();
  let key = '';
  let text = '';
  const m = title.match(/^(.*\S)\s*\(([^()]+)\)$/);
  if (m) {
    const inner = m[2].trim();
    const looks = /^[A-Za-z0-9⌘⇧⌥+/\-–, .]+$/.test(inner) && (/[A-Za-z]/.test(inner) || inner.length === 1 || inner.includes('–'));
    if (looks) { title = m[1]; key = inner; }
  }
  const colon = title.indexOf(': ');
  if (colon > 0 && colon <= 40) {
    text = title.slice(colon + 2);
    title = title.slice(0, colon);
    text = text.charAt(0).toUpperCase() + text.slice(1);
  }
  return { title, key, text };
}

export function initTooltips() {
  const card = document.createElement('div');
  card.className = 'tip-card';
  card.setAttribute('role', 'tooltip');
  document.body.append(card);

  let timer = 0;
  let hiddenAt = 0;
  let current = null;
  let waiting = null;

  const hide = () => {
    clearTimeout(timer);
    waiting = null;
    if (current) hiddenAt = performance.now();
    current = null;
    card.classList.remove('on');
  };

  const show = (node) => {
    const line = node.dataset.tipText;
    if (!line) return;
    const { title, key, text } = parse(line);
    if (!title) return;
    const head = document.createElement('div');
    head.className = 'tip-head';
    const name = document.createElement('span');
    name.className = 'tip-title';
    name.textContent = title;
    head.append(name);
    if (key) {
      const kbd = document.createElement('kbd');
      kbd.textContent = key;
      head.append(kbd);
    }
    card.replaceChildren(head);
    if (text) {
      const d = document.createElement('div');
      d.className = 'tip-text';
      d.textContent = text;
      card.append(d);
    }

    // Карточка живёт под масштабом интерфейса (zoom на body), а рамка
    // элемента — в точках экрана: переводим в её координаты.
    const k = parseFloat(getComputedStyle(document.body).zoom) || 1;
    const r = node.getBoundingClientRect();
    const box = { l: r.left / k, r: r.right / k, t: r.top / k, b: r.bottom / k };
    card.classList.add('on');
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const view = { w: innerWidth / k, h: innerHeight / k };
    const pad = 6;
    const gap = 8;
    let x;
    let y;
    if (node.closest('.rail')) {
      // Колонка у правого края окна — карточка слева от значка.
      x = box.l - w - gap;
      y = (box.t + box.b) / 2 - h / 2;
    } else if (node.closest('.pose-rail')) {
      // Колонка у левого края — справа от значка.
      x = box.r + gap;
      y = (box.t + box.b) / 2 - h / 2;
    } else {
      // Остальное — под элементом, а если внизу тесно — над ним.
      x = (box.l + box.r) / 2 - w / 2;
      y = box.b + gap;
      if (y + h > view.h - pad) y = box.t - h - gap;
    }
    x = Math.max(pad, Math.min(view.w - w - pad, x));
    y = Math.max(pad, Math.min(view.h - h - pad, y));
    card.style.left = x + 'px';
    card.style.top = y + 'px';
    current = node;
  };

  document.addEventListener('pointerover', (e) => {
    const node = e.target.closest?.('[title], [data-tip-text]');
    if (!node) return;
    // Свежий title главнее запомненного: его могли перевести или обновить.
    if (node.hasAttribute('title')) {
      const line = node.getAttribute('title');
      node.removeAttribute('title');
      if (line) node.dataset.tipText = line;
      else delete node.dataset.tipText;
    }
    if (!node.dataset.tipText) return;
    // Движение по дочерним элементам той же кнопки — не новый показ.
    if (node === current || node === waiting) return;
    clearTimeout(timer);
    waiting = null;
    if (current || performance.now() - hiddenAt < CHAIN) { show(node); return; }
    waiting = node;
    timer = setTimeout(() => { waiting = null; if (node.isConnected) show(node); }, DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    const node = e.target.closest?.('[data-tip-text]');
    if (!node || node.contains(e.relatedTarget)) return;
    hide();
  });
  // Нажали — уже знают, что это; карточка только мешала бы.
  document.addEventListener('pointerdown', () => { hide(); hiddenAt = 0; }, true);
  document.addEventListener('wheel', hide, { passive: true, capture: true });
  window.addEventListener('blur', hide);
}
