// Общие мелочи интерфейса: разметка, запросы к серверу, всплывашки.

export const $ = (s) => document.querySelector(s);

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'html') n.innerHTML = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : String(c));
  return n;
}

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fileUrl = (rel, dl) => '/files/' + rel.split('/').map(encodeURIComponent).join('/') + (dl ? '?download' : '');
export const base = (p) => p.split('/').pop();
export const money = (v) => '$' + (v || 0).toFixed(2);

export async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

export function toast(text, err = false) {
  const t = el('div', { class: 'toast' + (err ? ' err' : '') }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), err ? 5000 : 2600);
}


// Сегментный переключатель: options = [[значение, подпись, подсказка], …]
export function segment(options, value, onPick, cls = '') {
  return el('div', { class: 'seg ' + cls }, ...options.map(([v, label, title]) => el('button', {
    class: v === value ? 'on' : '', title, onclick: () => onPick(v),
  }, label)));
}
