/**
 * Значок приложения: из build/icon-source.png — в build/icon.png и src/app-icon.png.
 *
 * Исходник нарисован «в край» (тёмный квадрат во весь холст). В macOS значок
 * занимает не весь холст: вокруг поле, углы скруглены, под ним мягкая тень —
 * иначе он выглядит крупнее системных и выбивается из ряда в Dock.
 *
 * Считаем в Electron — он и так в зависимостях. Запуск: npm run icon
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon-source.png');
const OUT = path.join(ROOT, 'build', 'icon.png');
const OUT_UI = path.join(ROOT, 'src', 'app-icon.png');

const SIZE = 1024;      // холст значка
const MARGIN = 0.1;     // поле с каждой стороны, доля холста (сетка значков macOS: 824 из 1024)
const RADIUS = 0.225;   // радиус угла в долях стороны значка
const UI_SIZE = 256;    // значок в шапке окна

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  if (!fs.existsSync(SRC)) {
    console.error('[значок] нет исходника:', SRC);
    app.exit(1);
    return;
  }
  const win = new BrowserWindow({ show: false, width: 200, height: 200 });
  await win.loadURL('data:text/html,<meta charset="utf-8">');
  const data = fs.readFileSync(SRC).toString('base64');

  const res = await win.webContents.executeJavaScript(`(async () => {
    const img = new Image();
    img.src = 'data:image/png;base64,${data}';
    await img.decode();

    function draw(size) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const m = size * ${MARGIN};
      const s = size - 2 * m;
      const r = s * ${RADIUS};
      const shape = () => { g.beginPath(); g.roundRect(m, m, s, s, r); };
      // тень под плиткой — как у системных значков
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.30)';
      g.shadowBlur = size * 0.02;
      g.shadowOffsetY = size * 0.008;
      shape(); g.fillStyle = '#10151f'; g.fill();
      g.restore();
      // рисунок по скруглённой плитке
      g.save();
      shape(); g.clip();
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, m, m, s, s);
      g.restore();
      // тонкая светлая кромка: плитка не тонет на тёмном Dock
      g.save();
      shape(); g.lineWidth = Math.max(1, size * 0.002); g.strokeStyle = 'rgba(255,255,255,0.10)'; g.stroke();
      g.restore();
      return c.toDataURL('image/png').split(',')[1];
    }
    return { big: draw(${SIZE}), ui: draw(${UI_SIZE}) };
  })()`);

  fs.writeFileSync(OUT, Buffer.from(res.big, 'base64'));
  fs.writeFileSync(OUT_UI, Buffer.from(res.ui, 'base64'));
  console.log('[значок] готово:', path.relative(ROOT, OUT), '+', path.relative(ROOT, OUT_UI));
  app.quit();
});
