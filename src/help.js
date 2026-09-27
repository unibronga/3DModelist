// Окна «Справка и клавиши» и «О программе» — как в 3DPainter.

import { el } from './ui.js';
import { t } from './i18n.js';
import brand from './brand.png';

export const REPO = 'https://github.com/unibronga/3DModelist';
const AUTHOR = 'https://github.com/unibronga';
const EMAIL = 'icon.dnepr@gmail.com';
const MOD = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';

const link = (href, text) => el('a', { href, target: '_blank', rel: 'noreferrer' }, text || href);

// Своё окно поверх всего; закрывается крестиком, Esc и щелчком мимо.
function sheet(title, body, wide = false) {
  const back = el('div', { class: 'modal' });
  const close = () => { back.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  back.append(el('div', { class: 'sheet' + (wide ? ' wide' : '') },
    el('div', { class: 'sheet-head' }, el('div', { class: 'panel-title' }, title),
      el('button', { class: 'btn ghost', onclick: close }, t('common.close'))),
    el('div', { class: 'sheet-body' }, ...body)));
  document.body.append(back);
}

export function openHelp() {
  const block = (title, rows) => el('div', { class: 'help-block' },
    el('h3', {}, title),
    ...rows.map(([key, what]) => el('div', { class: 'help-row' }, el('kbd', {}, key), el('span', {}, what))));
  sheet(t('help.title'), [
    el('div', { class: 'help-how' },
      el('h3', {}, t('help.how')),
      el('ol', {}, el('li', {}, t('help.how.1')), el('li', {}, t('help.how.2')), el('li', {}, t('help.how.3')), el('li', {}, t('help.how.4')))),
    el('div', { class: 'help-grid' },
      block(t('help.mouse'), [
        [t('help.key.lmb'), t('help.mouse.rotate')],
        [t('help.key.rmb'), t('help.mouse.pan')],
        [t('help.key.wheel'), t('help.mouse.zoom')],
      ]),
      block(t('help.view'), [
        ['1', t('view.material')],
        ['2', t('view.clay')],
        ['3', t('view.wire')],
        ['F', t('view.flat')],
        ['Home', t('view.fit.hint')],
      ]),
      block(t('help.work'), [
        [MOD + 'N', t('side.new')],
        [MOD + '↵', t('help.work.send')],
        [MOD + ',', t('settings.title')],
        ['Esc', t('help.work.esc')],
      ]),
      block(t('help.ui'), [
        [MOD + '+', t('menu.bigger')],
        [MOD + '−', t('menu.smaller')],
        [MOD + '0', t('menu.normalSize')],
        ['F1', t('help.title')],
      ])),
    el('p', { class: 'muted' }, t('help.foot'), ' ', link(REPO + '#readme', 'README')),
  ], true);
}

export function openAbout(version) {
  sheet(t('about.title'), [
    el('div', { class: 'about-head' },
      el('img', { class: 'about-icon', src: brand, alt: '' }),
      el('div', {},
        el('div', { class: 'about-name' }, el('span', { class: 'name-3d' }, '3D'), 'Modelist'),
        el('div', { class: 'muted' }, t('about.version', { v: version })))),
    el('p', {}, t('about.desc')),
    el('div', { class: 'about-rows' },
      el('span', { class: 'muted' }, t('about.author')), el('span', {}, 'Kostiantyn Timchenko ', link(AUTHOR, '(Unibronga)')),
      el('span', { class: 'muted' }, t('about.email')), link('mailto:' + EMAIL, EMAIL),
      el('span', { class: 'muted' }, t('about.source')), link(REPO),
      el('span', { class: 'muted' }, t('about.license')), el('span', {}, link(REPO + '/blob/main/LICENSE', 'MIT'), ' · © 2026 Kostiantyn Timchenko'),
      el('span', { class: 'muted' }, t('about.builtWith')), el('span', {}, link('https://www.anthropic.com/claude', 'Claude'), ', ', link('https://www.blender.org', 'Blender'), ', ', link('https://threejs.org', 'three.js'), ', ', link('https://www.electronjs.org', 'Electron'))),
    el('p', { class: 'muted' }, t('about.licenseNote')),
  ]);
}
