// Каталог моделей Claude для агентов.
//
// Два вида выбора:
//   • «всегда последняя» — алиас CLI (fable, opus, sonnet, haiku): Claude сам
//     берёт свежую версию семейства, когда она выходит;
//   • конкретная версия — полное имя (claude-opus-5-5 и т.п.).
//
// Версии: встроенный список + свежий список из Anthropic API, если задан ключ
// API (подписке такой список недоступен). Любое другое имя можно вписать
// вручную — Claude Code примет его, если модель существует.

import fs from 'node:fs';
import path from 'node:path';
import { load as settings, appHome } from './settings.mjs';

export const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];

// Встроенные версии — на дату выпуска студии.
const BUILTIN = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

export const familyOf = (id) => FAMILIES.find((f) => String(id).includes(f)) || null;
export const validModel = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9.\-]{1,63}$/.test(id);
// Haiku моделистом не ставим: режим разрешений auto у него не включается.
export const canModel = (id) => validModel(id) && familyOf(id) !== 'haiku';

const CACHE = () => path.join(appHome(), 'models.json');
let mem = null;

async function fromApi(key) {
  const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  });
  if (!r.ok) throw new Error('models ' + r.status);
  const j = await r.json();
  return (j.data || [])
    .filter((m) => /^claude-/.test(m.id) && familyOf(m.id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((m) => ({ id: m.id, label: m.display_name?.replace(/^Claude\s+/, '') || m.id }));
}

// Список версий: API (раз в 12 часов, с кэшем на диске) + встроенные, без повторов.
export async function versions() {
  const s = settings();
  let fetched = [];
  if (s.claude.mode === 'api' && s.claude.apiKey) {
    if (mem && Date.now() - mem.t < 12 * 3600e3) fetched = mem.list;
    else {
      try {
        fetched = await fromApi(s.claude.apiKey);
        mem = { t: Date.now(), list: fetched };
        fs.mkdirSync(appHome(), { recursive: true });
        fs.writeFileSync(CACHE(), JSON.stringify(mem));
      } catch {
        try { mem = JSON.parse(fs.readFileSync(CACHE(), 'utf8')); fetched = mem.list; } catch { /* нет кэша */ }
      }
    }
  }
  const seen = new Set();
  return [...fetched, ...BUILTIN].filter((m) => !seen.has(m.id) && seen.add(m.id))
    .map((m) => ({ ...m, family: familyOf(m.id), modeler: canModel(m.id) }));
}
