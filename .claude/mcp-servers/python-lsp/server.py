#!/usr/bin/env python3
"""
MCP-сервер для Python LSP (pylsp).
Инструменты: python_diagnostics, python_definition, python_references, python_hover.
Переменная окружения: PROJECT_ROOT (корень проекта, по умолчанию — текущая директория).
"""

import asyncio
import json
import os
import sys
from pathlib import Path

from mcp.server import Server, NotificationOptions
from mcp.server.models import InitializationOptions
import mcp.server.stdio
import mcp.types as types


def to_uri(path: str) -> str:
    return Path(path).resolve().as_uri()


class PylspClient:
    """Управляет subprocess pylsp через JSON-RPC/stdio."""

    def __init__(self):
        self._proc = None
        self._req_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._diag_queues: dict[str, asyncio.Queue] = {}
        self._reader: asyncio.Task | None = None
        self._open_files: set[str] = set()

    async def start(self, root: str) -> None:
        python = sys.executable
        self._proc = await asyncio.create_subprocess_exec(
            python, "-m", "pylsp",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        self._reader = asyncio.create_task(self._read_loop())
        await self._initialize(root)

    async def _send(self, msg: dict) -> None:
        body = json.dumps(msg).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        self._proc.stdin.write(header + body)
        await self._proc.stdin.drain()

    async def _recv_one(self) -> dict | None:
        try:
            buf = b""
            while b"\r\n\r\n" not in buf:
                chunk = await self._proc.stdout.read(1)
                if not chunk:
                    return None
                buf += chunk
            length = int(buf.split(b"Content-Length:")[1].split(b"\r\n")[0].strip())
            body = await self._proc.stdout.readexactly(length)
            return json.loads(body)
        except Exception:
            return None

    async def _read_loop(self) -> None:
        while True:
            msg = await self._recv_one()
            if msg is None:
                break
            rid = msg.get("id")
            if rid is not None and rid in self._pending:
                fut = self._pending.pop(rid)
                if not fut.done():
                    fut.set_result(msg)
            elif msg.get("method") == "textDocument/publishDiagnostics":
                uri = msg["params"]["uri"]
                if uri in self._diag_queues:
                    await self._diag_queues[uri].put(msg["params"]["diagnostics"])

    async def _request(self, method: str, params) -> any:
        self._req_id += 1
        rid = self._req_id
        loop = asyncio.get_event_loop()
        fut: asyncio.Future = loop.create_future()
        self._pending[rid] = fut
        await self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        result = await asyncio.wait_for(fut, timeout=15.0)
        if "error" in result:
            raise RuntimeError(result["error"].get("message", "LSP error"))
        return result.get("result")

    async def _notify(self, method: str, params) -> None:
        await self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def _initialize(self, root: str) -> None:
        root_uri = Path(root).resolve().as_uri()
        await self._request("initialize", {
            "processId": None,
            "rootUri": root_uri,
            "capabilities": {
                "textDocument": {
                    "hover": {"contentFormat": ["plaintext", "markdown"]},
                    "definition": {"dynamicRegistration": False},
                    "references": {"dynamicRegistration": False},
                    "publishDiagnostics": {"dynamicRegistration": False},
                }
            },
        })
        await self._notify("initialized", {})

    async def _open(self, path: str) -> None:
        uri = to_uri(path)
        if uri in self._open_files:
            return
        text = Path(path).read_text(encoding="utf-8")
        await self._notify("textDocument/didOpen", {
            "textDocument": {"uri": uri, "languageId": "python", "version": 1, "text": text}
        })
        self._open_files.add(uri)

    async def _close(self, path: str) -> None:
        uri = to_uri(path)
        if uri not in self._open_files:
            return
        await self._notify("textDocument/didClose", {"textDocument": {"uri": uri}})
        self._open_files.discard(uri)

    async def diagnostics(self, path: str) -> list:
        uri = to_uri(path)
        queue: asyncio.Queue = asyncio.Queue()
        self._diag_queues[uri] = queue
        try:
            await self._open(path)
            diags = await asyncio.wait_for(queue.get(), timeout=10.0)
        except asyncio.TimeoutError:
            diags = []
        finally:
            del self._diag_queues[uri]
            await self._close(path)
        return diags

    async def definition(self, path: str, line: int, character: int):
        await self._open(path)
        result = await self._request("textDocument/definition", {
            "textDocument": {"uri": to_uri(path)},
            "position": {"line": line, "character": character},
        })
        await self._close(path)
        return result

    async def references(self, path: str, line: int, character: int):
        await self._open(path)
        result = await self._request("textDocument/references", {
            "textDocument": {"uri": to_uri(path)},
            "position": {"line": line, "character": character},
            "context": {"includeDeclaration": False},
        })
        await self._close(path)
        return result

    async def hover(self, path: str, line: int, character: int):
        await self._open(path)
        result = await self._request("textDocument/hover", {
            "textDocument": {"uri": to_uri(path)},
            "position": {"line": line, "character": character},
        })
        await self._close(path)
        return result


def fmt_location(loc: dict) -> str:
    path = loc["uri"].replace("file://", "")
    start = loc["range"]["start"]
    return f"{path}:{start['line'] + 1}:{start['character'] + 1}"


def fmt_diagnostic(d: dict) -> str:
    start = d["range"]["start"]
    sev = {1: "error", 2: "warning", 3: "info", 4: "hint"}.get(d.get("severity", 1), "error")
    source = f"[{d['source']}] " if d.get("source") else ""
    return f"  {sev} {source}line {start['line'] + 1}: {d['message']}"


_lsp: PylspClient | None = None
_root = os.environ.get("PROJECT_ROOT", os.getcwd())

server = Server("python-lsp")


@server.list_tools()
async def list_tools() -> list[types.Tool]:
    return [
        types.Tool(
            name="python_diagnostics",
            description="Ошибки типов и синтаксиса в Python-файле (от pylsp).",
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Абсолютный путь к .py файлу"},
                },
                "required": ["file_path"],
            },
        ),
        types.Tool(
            name="python_definition",
            description=(
                "Где определён символ в позиции (line, character). "
                "Возвращает путь и строку без чтения файлов. "
                "Строки и символы считаются с 0."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Абсолютный путь к .py файлу"},
                    "line": {"type": "integer", "description": "Номер строки (с 0)"},
                    "character": {"type": "integer", "description": "Позиция символа (с 0)"},
                },
                "required": ["file_path", "line", "character"],
            },
        ),
        types.Tool(
            name="python_references",
            description=(
                "Все места использования символа в позиции (line, character). "
                "Возвращает список файл:строка без чтения файлов."
            ),
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Абсолютный путь к .py файлу"},
                    "line": {"type": "integer", "description": "Номер строки (с 0)"},
                    "character": {"type": "integer", "description": "Позиция символа (с 0)"},
                },
                "required": ["file_path", "line", "character"],
            },
        ),
        types.Tool(
            name="python_hover",
            description="Тип и документация символа в позиции (line, character).",
            inputSchema={
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Абсолютный путь к .py файлу"},
                    "line": {"type": "integer", "description": "Номер строки (с 0)"},
                    "character": {"type": "integer", "description": "Позиция символа (с 0)"},
                },
                "required": ["file_path", "line", "character"],
            },
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict | None) -> list[types.TextContent]:
    global _lsp
    if _lsp is None:
        _lsp = PylspClient()
        await _lsp.start(_root)

    args = arguments or {}
    try:
        path = args["file_path"]

        if name == "python_diagnostics":
            diags = await _lsp.diagnostics(path)
            if not diags:
                text = "Ошибок не найдено."
            else:
                lines = [f"Найдено {len(diags)} проблем в {path}:"]
                lines += [fmt_diagnostic(d) for d in diags]
                text = "\n".join(lines)

        elif name == "python_definition":
            result = await _lsp.definition(path, args["line"], args["character"])
            if not result:
                text = "Определение не найдено."
            elif isinstance(result, list):
                text = "\n".join(fmt_location(loc) for loc in result)
            else:
                text = fmt_location(result)

        elif name == "python_references":
            result = await _lsp.references(path, args["line"], args["character"])
            if not result:
                text = "Использований не найдено."
            else:
                locs = "\n".join(fmt_location(loc) for loc in result)
                text = f"Найдено {len(result)} использований:\n{locs}"

        elif name == "python_hover":
            result = await _lsp.hover(path, args["line"], args["character"])
            if not result or not result.get("contents"):
                text = "Информация недоступна."
            else:
                contents = result["contents"]
                if isinstance(contents, dict):
                    text = contents.get("value", str(contents))
                elif isinstance(contents, list):
                    parts = [c.get("value", c) if isinstance(c, dict) else c for c in contents]
                    text = "\n".join(parts)
                else:
                    text = str(contents)
        else:
            text = f"Неизвестный инструмент: {name}"

    except Exception as e:
        text = f"Ошибка: {e}"

    return [types.TextContent(type="text", text=text)]


async def main() -> None:
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="python-lsp",
                server_version="1.0.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )


if __name__ == "__main__":
    asyncio.run(main())
