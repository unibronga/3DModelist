// Кто подключён: имя и тариф Claude, остаток денег на fal.ai — для плашки
// внизу слева. Всё локальное и бесплатное; кэш на минуту.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { load as settings, exists, fullPath } from './settings.mjs';
import { falKey } from './fal.mjs';
import { listTasks } from './store.mjs';

let cache = { t: 0, v: null };

// Имя — из файла входа Claude Code (~/.claude.json или <профиль>/.claude.json).
function claudeName() {
  const dir = settings().claude.configDir;
  const file = dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount || {};
    return a.displayName || (a.fullName || '').split(' ')[0] || null;
  } catch { return null; }
}

// Тариф и вход — `claude auth status --json`, в чистом окружении.
function claudeStatus() {
  const s = settings();
  return new Promise((resolve) => {
    if (!exists(s.claude.bin)) { resolve(null); return; }
    const env = { HOME: os.homedir(), USER: os.userInfo().username, PATH: fullPath() };
    if (s.claude.configDir) env.CLAUDE_CONFIG_DIR = s.claude.configDir;
    let out = '';
    const p = spawn(s.claude.bin, ['auth', 'status', '--json'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => p.kill('SIGKILL'), 10000);
    p.stdout.on('data', (c) => { out += c; });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
    p.on('close', () => { clearTimeout(timer); try { resolve(JSON.parse(out)); } catch { resolve(null); } });
  });
}

// Остаток на fal: /v1/account/billing отдаёт его только ключу с правом ADMIN.
async function falBalance() {
  const key = falKey();
  if (!key) return { key: false };
  try {
    const r = await fetch('https://api.fal.ai/v1/account/billing?expand=credits', { headers: { Authorization: `Key ${key}` } });
    if (r.status === 401 || r.status === 403) return { key: true, scope: false };
    const j = await r.json();
    const c = j.credits || {};
    const balance = c.current_balance ?? c.balance ?? c.amount ?? null;
    return { key: true, scope: true, balance: balance == null ? null : Number(balance), currency: c.currency || 'USD' };
  } catch {
    return { key: true, net: false };
  }
}

export async function account() {
  if (cache.v && Date.now() - cache.t < 60000) return cache.v;
  const s = settings();
  const [st, fal] = await Promise.all([s.claude.mode === 'subscription' ? claudeStatus() : null, falBalance()]);
  const spent = listTasks().reduce((sum, t) => sum + (t.spent_usd || 0), 0);
  const v = {
    claude: s.claude.mode === 'api'
      ? { mode: 'api', tail: s.claude.apiKey ? s.claude.apiKey.slice(-4) : null }
      : { mode: 'subscription', loggedIn: !!st?.loggedIn, name: claudeName(), plan: st?.subscriptionType || null },
    fal: { ...fal, spent },
  };
  cache = { t: Date.now(), v };
  return v;
}

export const dropAccountCache = () => { cache = { t: 0, v: null }; };
