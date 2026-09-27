// Язык интерфейса.
//
// Словари — по файлу на язык в lang/, ключи плоские вида 'form.title'.
// Подстановки именованные: t('ev.created', { slug, n }).
// Смена языка не перезагружает страницу: подписчики перерисовывают свои
// надписи сами, разметку с data-i18n переводит applyDOM().
//
// Агент от этого языка не зависит: он отвечает на том языке, на котором ему
// пишут, а язык интерфейса получает только как подсказку.

import en from './lang/en.js';
import de from './lang/de.js';
import fr from './lang/fr.js';
import nl from './lang/nl.js';
import es from './lang/es.js';
import uk from './lang/uk.js';
import ru from './lang/ru.js';

// Имя языка — на самом языке: так его находит тот, кто на нём говорит.
export const LANGS = {
  en: 'English', de: 'Deutsch', fr: 'Français', nl: 'Nederlands',
  es: 'Español', uk: 'Українська', ru: 'Русский',
};

const DICTS = { en, de, fr, nl, es, uk, ru };
const STORE = 'modelist.lang';
const subs = new Set();

function initial() {
  try {
    const saved = localStorage.getItem(STORE);
    if (saved && DICTS[saved]) return saved;
  } catch { /* приватный режим */ }
  const sys = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return DICTS[sys] ? sys : 'en';
}

let cur = initial();
document.documentElement.lang = cur;

export const getLang = () => cur;

// Неизвестный ключ возвращается как есть — пропуск видно на экране.
export function t(key, params) {
  const s = DICTS[cur]?.[key] ?? DICTS.en[key] ?? DICTS.ru[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => (params[k] ?? '')) : s;
}

export const has = (key) => key in DICTS.en || key in DICTS.ru;

export function setLang(code) {
  if (!DICTS[code] || code === cur) return false;
  cur = code;
  try { localStorage.setItem(STORE, code); } catch { /* приватный режим */ }
  document.documentElement.lang = code;
  applyDOM();
  subs.forEach((fn) => fn(code));
  return true;
}

export function onLangChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

// Разметка: data-i18n — текст, data-i18n-title — подсказка, data-i18n-ph — placeholder.
export function applyDOM(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
  root.querySelectorAll('[data-i18n-title]').forEach((n) => { n.title = t(n.dataset.i18nTitle); });
  root.querySelectorAll('[data-i18n-ph]').forEach((n) => { n.placeholder = t(n.dataset.i18nPh); });
}

// Числа — по правилам текущего языка.
export const num = (v) => Number(v).toLocaleString(cur);

// Каких ключей нет в словаре языка (для проверки полноты переводов).
export function missingKeys(code) {
  const d = DICTS[code] || {};
  return Object.keys(DICTS.ru).filter((k) => !(k in d));
}
