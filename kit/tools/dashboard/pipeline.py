# -*- coding: utf-8 -*-
"""Общее описание пайплайна: этапы, скилы, ворота.

Один источник правды для сервера пульта и для CLI `tools/pipe`.
Порядок и состав обязаны совпадать с разделом «Pipeline модели» в CLAUDE.md.
"""

import json
import os
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNS = os.path.join(ROOT, "runs")
CURRENT = os.path.join(RUNS, "current")

STAGES = [
    {"n": 0, "skill": "blender-reference", "title": "Референс и спека",
     "what": "референс refs/<проект>/ глазами, спека числами и счётом "
             "(стиля заранее нет — всё с референса)", "gate": True},
    {"n": 1, "skill": "blender-model",    "title": "Форма",
     "what": "конструкция скриптом (органика — ветка fal-generate), масштаб "
             "в метры, чистка сетки; кадр после каждой правки", "gate": False},
    {"n": 2, "skill": "blender-look",     "title": "Подача",
     "what": "палитра и материалы по спеке (srgb), свет, камера", "gate": False},
    {"n": 3, "skill": "blender-inspect",  "title": "Приёмка",
     "what": "объём по классу ассета: clean_mesh → audit.py → кадры → "
             "вьюпорт глазами → критик", "gate": False},
    # этап 4 (substance-paint) снят 19.09: Painter убран из пайплайна,
    # номера не сдвигаются — статусы прошлых прогонов ищут этап по n
    {"n": 5, "skill": "blender-export",   "title": "Выдача",
     "what": "purge() → .blend + рендеры + GLB/FBX/OBJ/STL", "gate": False},
]


def blank_status(task=""):
    return {
        "task": task,
        "started_at": None,
        "finished_at": None,
        "stages": [
            {"n": s["n"], "state": "pending", "started_at": None,
             "finished_at": None, "note": ""}
            for s in STAGES
        ],
    }


def _path(name):
    return os.path.join(CURRENT, name)


def load(name, default=None):
    try:
        with open(_path(name), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def save(name, data):
    os.makedirs(CURRENT, exist_ok=True)
    tmp = _path(name) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, _path(name))          # атомарно: пульт читает во время записи
    return data


def set_task(task):
    """Новая задача: обнулить хронометраж и записать её название в шапку."""
    return save("status.json", blank_status(task))


def set_stage(n, state, note=""):
    """Перевести этап в состояние. Вызывается из tools/pipe по ходу работы."""
    st = load("status.json") or blank_status()
    now = time.time()
    if st.get("started_at") is None:
        st["started_at"] = now
    for row in st["stages"]:
        if row["n"] != n:
            continue
        if state == "running":
            row["started_at"] = now
            row["finished_at"] = None
        elif state in ("done", "skipped"):
            row["finished_at"] = now
            if row["started_at"] is None:
                row["started_at"] = now
        row["state"] = state
        if note:
            row["note"] = note
    if all(r["state"] in ("done", "skipped") for r in st["stages"]):
        st["finished_at"] = now
    return save("status.json", st)
