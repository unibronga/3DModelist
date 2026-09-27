// Тема и масштаб интерфейса. Источник правды — настройки на сервере (их делят
// окно приложения и браузер); localStorage — только чтобы при запуске не
// мигнуть не той темой, пока настройки не пришли (см. скрипт в index.html).

const subs = new Set();
export const onScaleChange = (fn) => subs.add(fn);

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;               // «как в системе»
  try { localStorage.setItem('modelist.theme', theme || 'system'); } catch { /* приватный режим */ }
}

export function applyScale(k) {
  const v = Math.min(1.4, Math.max(0.8, Number(k) || 1));
  document.documentElement.style.setProperty('--ui', String(v));
  try { localStorage.setItem('modelist.scale', String(v)); } catch { /* приватный режим */ }
  subs.forEach((fn) => fn(v));
}

export const getScale = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui')) || 1;
