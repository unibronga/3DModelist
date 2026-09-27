// Проверка словарей: во всех языках те же ключи и те же подстановки, что в
// ru.js, и каждый ключ, написанный в коде буквально (t('...'), data-i18n),
// есть в словаре. Запуск: npm run i18n
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['ru', 'en', 'de', 'fr', 'nl', 'es', 'uk'];
const D = {};
for (const l of LANGS) D[l] = (await import(path.join(ROOT, 'src', 'lang', l + '.js'))).default;

const ph = (s) => JSON.stringify((s.match(/\{\w+\}/g) || []).sort());
let bad = 0;
for (const l of LANGS) {
  const miss = Object.keys(D.ru).filter((k) => !(k in D[l]));
  const extra = Object.keys(D[l]).filter((k) => !(k in D.ru));
  const wrong = Object.keys(D.ru).filter((k) => k in D[l] && ph(D.ru[k]) !== ph(D[l][k]));
  if (miss.length || extra.length || wrong.length) {
    bad++;
    console.log(`${l}: нет ${miss.join(', ') || '—'} | лишние ${extra.join(', ') || '—'} | подстановки ${wrong.join(', ') || '—'}`);
  } else console.log(`${l}: ок, ключей ${Object.keys(D[l]).length}`);
}

const code = ['index.html', ...fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => 'src/' + f)]
  .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const used = new Set([
  ...[...code.matchAll(/\bt\('([\w.]+)'/g)].map((m) => m[1]),
  ...[...code.matchAll(/data-i18n(?:-title|-ph)?="([\w.]+)"/g)].map((m) => m[1]),
]);
const missing = [...used].filter((k) => !k.endsWith('.') && !(k in D.ru));
if (missing.length) { bad++; console.log('в коде, но не в словаре:', missing.join(', ')); }
process.exit(bad ? 1 : 0);
