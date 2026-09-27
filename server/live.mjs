// Модель вживую и версии.
//
// Агент строит форму скриптом: правка scenes/<имя>.py → прогон `tools/bl` →
// лист ракурсов. Сразу после каждого такого прогона студия сама просит
// Blender выгрузить снимок сцены — быстрый GLB, миниатюру и список частей —
// в runs/studio/<id>/live/vN.*, плюс копию скрипта. Человек видит модель в
// окне по ходу работы, а не только после выдачи, и может вернуть любую версию:
// скрипт той версии лежит рядом.
//
// Агенту для этого делать ничего не надо — он даже не знает о снимках.

import fs from 'node:fs';
import path from 'node:path';
import { ws, tasksDir, addEvent } from './store.mjs';
import { execute } from './blender.mjs';

export const liveDir = (id) => path.join(tasksDir(), id, 'live');
const rel = (abs) => path.relative(ws(), abs).split(path.sep).join('/');

// Прогон скрипта сцены в команде Bash агента: `tools/bl scenes/x.py --peek …`.
// -c/--code и --ping — замеры, сцену не строят; scripts/*.py — проверки.
export function sceneScript(command) {
  const m = /(?:^|[\s;&|(])(?:\.\/)?tools\/bl\b([^;&|\n]*)/.exec(String(command || ''));
  if (!m) return null;
  const args = m[1].trim().split(/\s+/).map((a) => a.replace(/^['"]|['"]$/g, ''));
  if (args.some((a) => a === '-c' || a === '--code' || a.startsWith('--code=') || a === '--ping')) return null;
  const script = args.find((a) => /(?:^|\/)scenes\/.+\.py$/.test(a));
  if (!script) return null;
  const abs = path.resolve(ws(), script);
  return abs.startsWith(ws() + path.sep) ? rel(abs) : null;
}

export function listVersions(id) {
  let names = [];
  try { names = fs.readdirSync(liveDir(id)); } catch { return []; }
  return names.filter((f) => /^v\d+\.json$/.test(f))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(liveDir(id), f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => a.n - b.n);
}

// Снимок в Blender: те же объекты, что снимает лист ракурсов (_peek_objects —
// без пола-подложки и служебных камер), выделение возвращается как было.
const SNAPSHOT_PY = (glb, png) => `
_objs = _peek_objects()
_res = {'parts': [], 'tris': 0, 'thumb': None}
if _objs:
    _vl = bpy.context.view_layer
    _sel = [o for o in _vl.objects if o.select_get()]
    _act = _vl.objects.active
    def _pick(objs, on):
        for _o in objs:
            try:
                _o.select_set(on)
            except RuntimeError:
                pass
    _pick(_sel, False)
    _pick(_objs, True)
    try:
        bpy.ops.export_scene.gltf(filepath=${JSON.stringify(glb)}, export_format='GLB', use_selection=True,
                                  export_apply=True, export_cameras=False, export_lights=False,
                                  export_animations=False)
    finally:
        _pick(_objs, False)
        _pick(_sel, True)
        _vl.objects.active = _act
    _dg = bpy.context.evaluated_depsgraph_get()
    for _o in _objs:
        _t = 0
        if _o.type == 'MESH':
            _e = _o.evaluated_get(_dg)
            _m = _e.to_mesh()
            _m.calc_loop_triangles()
            _t = len(_m.loop_triangles)
            _e.to_mesh_clear()
        _bb = [_o.matrix_world @ Vector(c) for c in _o.bound_box]
        _res['parts'].append({
            'name': _o.name, 'tris': _t,
            'min': [round(min(v[i] for v in _bb), 4) for i in range(3)],
            'max': [round(max(v[i] for v in _bb), 4) for i in range(3)],
        })
        _res['tris'] += _t
    _res['thumb'] = peek(${JSON.stringify(png)}, views=('q34',), tile=320, cols=1).get('path')
result = _res
`;

const queues = new Map();          // id задачи → цепочка снимков (по одному за раз)

// Поставить снимок в очередь задачи. Ошибки не роняют ход агента: снимок —
// удобство для человека, а не часть сдачи.
export function snapshot(id, script) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.then(() => take(id, script)).catch((e) => {
    console.error('[3DModelist] снимок модели не вышел:', e.message);
  });
  queues.set(id, next);
  return next;
}

async function take(id, script) {
  const root = ws();
  const prelude = path.join(root, 'lib', 'artist.py');
  if (!fs.existsSync(prelude)) return null;
  let text;
  try { text = fs.readFileSync(path.join(root, script), 'utf8'); } catch { return null; }

  const dir = liveDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const all = listVersions(id);
  const last = all[all.length - 1];
  // Тот же скрипт (крупный план, повторный лист) — та же форма: новой версии нет.
  if (last && last.script === script) {
    try { if (fs.readFileSync(path.join(dir, `v${last.n}.py`), 'utf8') === text) return null; } catch { /* нет копии — снимаем */ }
  }
  const n = (last?.n || 0) + 1;
  const glb = path.join(dir, `v${n}.glb`);
  const png = path.join(dir, `v${n}.png`);

  const code = fs.readFileSync(prelude, 'utf8') + '\n\n# ── снимок студии ──\n' + SNAPSHOT_PY(glb, png);
  const r = await execute(code, { timeout: 60000 });
  if (r.status !== 'ok') throw new Error(String(r.message || 'Blender вернул ошибку').split('\n').slice(-2).join(' '));
  const res = r.result || {};
  if (!fs.existsSync(glb)) return null;          // в сцене нечего выгружать

  fs.writeFileSync(path.join(dir, `v${n}.py`), text);
  const meta = {
    n, t: Date.now() / 1000, script,
    glb: rel(glb),
    thumb: res.thumb && fs.existsSync(res.thumb) ? rel(res.thumb) : null,
    code: rel(path.join(dir, `v${n}.py`)),
    tris: res.tris || 0,
    parts: res.parts || [],
  };
  fs.writeFileSync(path.join(dir, `v${n}.json`), JSON.stringify(meta, null, 2));
  addEvent(id, { kind: 'system', key: 'ev.version', params: { n } });
  return meta;
}
