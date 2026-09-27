#!/usr/bin/env python3
"""
Мост к официальному аддону Blender MCP (lab_blender_org/mcp).

Аддон поднимает внутри Blender TCP-сокет (по умолчанию localhost:9876) и
принимает NUL-терминированный JSON вида
    {"type": "execute", "code": "<python>", "strict_json": false}
и отвечает таким же NUL-терминированным JSON
    {"status": "ok", "result": ..., "stdout": ...}  |  {"status": "error", "message": ...}

Код выполняется ВНУТРИ процесса Blender, поэтому доступен весь `bpy`.
Переменная `result` в коде — то, что вернётся вызывающему.

Использование:
    python3 blender_bridge.py -f script.py      # выполнить файл
    echo 'print(1)' | python3 blender_bridge.py # выполнить stdin
    python3 blender_bridge.py -c 'result=len(bpy.data.objects)'
    python3 blender_bridge.py --ping            # проверить связь
"""

import argparse
import json
import os
import socket
import sys

HOST = os.environ.get("BLENDER_MCP_HOST", "localhost")
PORT = int(os.environ.get("BLENDER_MCP_PORT", "9876"))
# Долгий дефолт: рендер и тяжёлые модификаторы блокируют сокет до завершения.
TIMEOUT = float(os.environ.get("BLENDER_MCP_TIMEOUT", "600"))


class BridgeError(RuntimeError):
    """Ошибка транспорта либо ошибка выполнения кода в Blender."""


def execute(code: str, host: str = HOST, port: int = PORT, timeout: float = TIMEOUT) -> dict:
    """Отправить python-код в Blender и вернуть распарсенный ответ."""
    payload = json.dumps({"type": "execute", "code": code, "strict_json": False}) + "\0"
    try:
        with socket.create_connection((host, port), timeout=10) as sock:
            sock.settimeout(timeout)
            sock.sendall(payload.encode("utf-8"))
            buf = bytearray()
            while b"\0" not in buf:
                chunk = sock.recv(65536)
                if not chunk:
                    raise BridgeError("Blender закрыл соединение, не прислав ответ")
                buf.extend(chunk)
    except ConnectionRefusedError:
        raise BridgeError(
            f"Нет соединения с Blender на {host}:{port}.\n"
            "Проверь: Blender запущен из 3DModelist (Настройки ▸ Blender ▸ Запустить)\n"
            "либо в нём включён аддон Blender Lab MCP (Preferences ▸ Add-ons ▸ MCP ▸ Start)."
        ) from None
    except socket.timeout:
        raise BridgeError(f"Таймаут {timeout}с — Blender не ответил (тяжёлая операция или зависание).") from None

    return json.loads(bytes(buf[: buf.index(b"\0")]).decode("utf-8"))


def run(code: str, **kw) -> object:
    """Выполнить код и вернуть `result`, подняв исключение при ошибке."""
    resp = execute(code, **kw)
    if resp.get("status") != "ok":
        raise BridgeError(resp.get("message", "неизвестная ошибка Blender"))
    return resp.get("result")


def main() -> int:
    ap = argparse.ArgumentParser(description="Выполнить python-код внутри Blender через MCP-аддон")
    ap.add_argument("-f", "--file", help="файл со скриптом")
    ap.add_argument("-c", "--code", help="код строкой")
    ap.add_argument("--ping", action="store_true", help="проверка связи")
    ap.add_argument("--host", default=HOST)
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--timeout", type=float, default=TIMEOUT)
    args = ap.parse_args()

    if args.ping:
        code = (
            "import bpy\n"
            "result = {'blender': bpy.app.version_string,\n"
            "          'file': bpy.data.filepath or '(без имени)',\n"
            "          'objects': [o.name for o in bpy.data.objects]}\n"
        )
    elif args.code:
        code = args.code
    elif args.file:
        with open(args.file, encoding="utf-8") as fh:
            code = fh.read()
    else:
        code = sys.stdin.read()

    try:
        resp = execute(code, host=args.host, port=args.port, timeout=args.timeout)
    except BridgeError as ex:
        print(f"ОШИБКА МОСТА: {ex}", file=sys.stderr)
        return 2

    # stdout из Blender печатаем как есть — это print()-отладка внутри сцены.
    for key in ("stdout", "stderr"):
        text = resp.get(key)
        if text:
            sys.stderr.write(text if text.endswith("\n") else text + "\n")

    if resp.get("status") != "ok":
        print("ОШИБКА BLENDER:\n" + str(resp.get("message", "")), file=sys.stderr)
        return 1

    print(json.dumps(resp.get("result"), ensure_ascii=False, indent=2, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
