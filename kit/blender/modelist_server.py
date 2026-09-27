# -*- coding: utf-8 -*-
"""Сервер 3DModelist внутри Blender: принимает python-код по TCP и исполняет его.

Запуск (студия делает это кнопкой «Запустить Blender»):

    Blender --python blender/modelist_server.py               # с окном
    Blender --background --python blender/modelist_server.py  # без окна

Протокол — тот же, что у официального аддона Blender Lab MCP, поэтому
tools/blender_bridge.py работает с любым из них:

    запрос:  {"type": "execute", "code": "<python>", "strict_json": false}\\0
    ответ:   {"status": "ok", "result": ..., "stdout": "..."}\\0
             {"status": "error", "message": "<traceback>", "stdout": "..."}\\0

Переменная `result` в коде — то, что уйдёт обратно. Слушает только 127.0.0.1.
🔴 Песочницы нет: код исполняется с правами Blender.
"""

import contextlib
import io
import json
import os
import socket
import sys
import traceback

import bpy

HOST = "127.0.0.1"
PORT = int(os.environ.get("BLENDER_MCP_PORT", "9876"))
POLL = 0.05                                   # секунды между проверками сокета в GUI


def _execute(code):
    ns = {"result": {}, "__name__": "__modelist__", "bpy": bpy}   # bpy под рукой, как в консоли Blender
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            exec(compile(code, "<modelist>", "exec"), ns)
            resp = {"status": "ok", "result": json.loads(json.dumps(ns.get("result"), default=repr))}
        except Exception:                     # noqa: BLE001 — трейсбек уходит агенту
            resp = {"status": "error", "message": traceback.format_exc()}
    if out.getvalue():
        resp["stdout"] = out.getvalue()
    if err.getvalue():
        resp["stderr"] = err.getvalue()
    return resp


def _serve_one(conn):
    conn.settimeout(60)
    buf = bytearray()
    while b"\0" not in buf:
        chunk = conn.recv(65536)
        if not chunk:
            return
        buf.extend(chunk)
    try:
        req = json.loads(bytes(buf[: buf.index(b"\0")]).decode("utf-8"))
        if req.get("type") != "execute":
            resp = {"status": "error", "message": "неизвестный тип запроса: %r" % req.get("type")}
        else:
            resp = _execute(req.get("code", ""))
    except Exception:                         # noqa: BLE001
        resp = {"status": "error", "message": traceback.format_exc()}
    conn.sendall((json.dumps(resp) + "\0").encode("utf-8"))


def _listen():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        srv.bind((HOST, PORT))
    except OSError:
        print("[3DModelist] порт %d занят — сервер не поднят (уже работает другой?)" % PORT)
        return None
    srv.listen(4)
    print("[3DModelist] сервер Blender слушает %s:%d" % (HOST, PORT))
    return srv


def run_background():
    """Без окна: обычный блокирующий цикл, Blender живёт, пока жив сервер."""
    srv = _listen()
    if srv is None:
        sys.exit(1)
    while True:
        conn, _ = srv.accept()
        with conn:
            try:
                _serve_one(conn)
            except Exception:                 # noqa: BLE001
                traceback.print_exc()


def run_gui():
    """С окном: неблокирующий сокет и таймер — интерфейс Blender не замирает."""
    srv = _listen()
    if srv is None:
        return
    srv.setblocking(False)

    def tick():
        try:
            conn, _ = srv.accept()
        except BlockingIOError:
            return POLL
        conn.setblocking(True)
        with conn:
            try:
                _serve_one(conn)
            except Exception:                 # noqa: BLE001
                traceback.print_exc()
        return 0.0                            # сразу проверить, нет ли следующего

    bpy.app.timers.register(tick, persistent=True)


if bpy.app.background:
    run_background()
else:
    run_gui()
