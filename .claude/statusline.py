#!/usr/bin/env python3
"""
Status line для ArchMap. Харнесс передаёт на stdin JSON о текущей сессии
(модель, рабочая папка, путь к транскрипту, накопленная стоимость/правки),
а скрипт собирает из него однострочную приборную панель.

Принципы:
- Быстро: читаем только хвост транскрипта, никаких тяжёлых операций
  (тесты/линтеры тут гонять нельзя — скрипт дёргается на каждое обновление).
- Честно: показываем только то, что реально доступно скрипту. Внутренние
  счётчики харнесса (число вызовов инструментов, «повторы», режим прав) сюда
  не передаются — их не выдумываем.
"""
import sys
import os
import json
import subprocess

# Размер контекстного окна модели (Opus 4.x). Используется для шкалы «занято/всего».
CTX_MAX = 200_000

# --- ANSI-цвета (тема тёмная) ---
def c(code: str, text: str) -> str:
    return f"\033[{code}m{text}\033[0m"

DIM = "2;37"
SEP = c(DIM, " │ ")


def read_stdin_json() -> dict:
    try:
        return json.load(sys.stdin)
    except Exception:
        return {}


def git(project_dir: str, *args: str) -> str:
    """Короткий git-вызов с таймаутом; пустая строка при любой ошибке."""
    try:
        r = subprocess.run(
            ["git", "-C", project_dir, *args],
            capture_output=True, text=True, timeout=1,
        )
        return r.stdout.strip()
    except Exception:
        return ""


def git_segment(project_dir: str) -> str:
    if git(project_dir, "rev-parse", "--is-inside-work-tree") != "true":
        return c(DIM, "⎇ no-git")
    branch = git(project_dir, "rev-parse", "--abbrev-ref", "HEAD") or "?"
    dirty = [ln for ln in git(project_dir, "status", "--porcelain").splitlines() if ln.strip()]
    if dirty:
        return c("33", f"⎇ {branch} ±{len(dirty)}")   # жёлтый: есть несохранённые правки
    return c("32", f"⎇ {branch} ✓")                    # зелёный: чисто


def mcp_segment(project_dir: str) -> str:
    """Список сконфигурированных MCP-серверов из .mcp.json (это же наш LSP)."""
    try:
        with open(os.path.join(project_dir, ".mcp.json")) as f:
            servers = list(json.load(f).get("mcpServers", {}).keys())
    except Exception:
        return ""
    if not servers:
        return ""
    return c("36", "🔌 " + ",".join(servers))


def tail_lines(path: str, max_bytes: int = 262_144) -> list[str]:
    """Последние ~256 КБ файла построчно (хвоста хватает: свежий usage — в конце)."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        start = max(0, size - max_bytes)
        f.seek(start)
        data = f.read()
    lines = data.decode("utf-8", "replace").splitlines()
    if start > 0 and lines:
        lines = lines[1:]  # первая строка могла обрезаться — выкидываем
    return lines


def humanize(n: int) -> str:
    """Компактно: 870 → '870', 87000 → '87k', 1_200_000 → '1.2M'."""
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n // 1000}k"
    return str(n)


def out_tokens_segment(transcript: str) -> str:
    """Суммарно сгенерированных (output) токенов за всю сессию.

    Считаем по ВСЕМУ транскрипту: output копится с каждым ответом, в хвосте
    его не собрать. Берём output_tokens из usage каждого ответа ассистента
    (включая суб-агентов — это тоже потраченные за сессию токены).
    """
    if not transcript or not os.path.exists(transcript):
        return ""
    total = 0
    try:
        with open(transcript, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                usage = (obj.get("message") or {}).get("usage")
                if usage:
                    total += usage.get("output_tokens", 0)
    except Exception:
        return ""
    if not total:
        return ""
    return c("35", f"↑ {humanize(total)} tok")  # пурпурный: сгенерировано за сессию


def ctx_segment(transcript: str) -> str:
    """Заполнение контекста = input+cache последнего ответа основной ветки."""
    if not transcript or not os.path.exists(transcript):
        return ""
    used = 0
    try:
        for line in reversed(tail_lines(transcript)):
            try:
                obj = json.loads(line)
            except Exception:
                continue
            if obj.get("isSidechain"):
                continue  # это сообщения суб-агента, не основной контекст
            usage = (obj.get("message") or {}).get("usage")
            if usage:
                used = (
                    usage.get("input_tokens", 0)
                    + usage.get("cache_read_input_tokens", 0)
                    + usage.get("cache_creation_input_tokens", 0)
                )
                break
    except Exception:
        return ""
    if not used:
        return ""
    pct = round(used * 100 / CTX_MAX)
    color = "32" if pct < 70 else "33" if pct < 90 else "31"  # зел/жёл/красн
    return c(color, f"🧠 {used // 1000}k/{CTX_MAX // 1000}k ({pct}%)")


def main() -> None:
    data = read_stdin_json()
    ws = data.get("workspace") or {}
    project_dir = ws.get("project_dir") or data.get("cwd") or os.getcwd()
    model = (data.get("model") or {}).get("display_name", "?")
    cost = data.get("cost") or {}
    added = cost.get("total_lines_added", 0)
    removed = cost.get("total_lines_removed", 0)

    repo = os.path.basename(project_dir.rstrip("/")) or "?"

    segments = [
        c("1;36", f"📁 {repo}"),               # имя проекта — ярко
        git_segment(project_dir),
        c(DIM, f"🤖 {model}"),
        mcp_segment(project_dir),
        c("32", f"+{added}") + c(DIM, "/") + c("31", f"-{removed}"),  # правки сессии
        ctx_segment(transcript=data.get("transcript_path", "")),
        out_tokens_segment(transcript=data.get("transcript_path", "")),
    ]
    print(SEP.join(s for s in segments if s))


if __name__ == "__main__":
    main()
