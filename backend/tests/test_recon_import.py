"""Приём перечня разведки (Ф1 docs/plan-recon.md): разбор файла и строки → заглушки.

Проверяется то, чем этот путь отличается от прочих приёмников: перечень приезжает
через пользователя (ограждения, битый YAML), опознаётся по разделам, а его строки
становятся ЗАГЛУШКАМИ — схемами с пустым телом.

Главный сторож — test_образец_промпта_разбирается: формат диктует промпт (Ф0), под
него подстраивается приёмник, и расхождение обязано валить тест, а не всплывать в
поле.
"""

from app.recon_import import (
    MAX_ENTRY_LEN,
    MAX_RECON_LINES,
    ParsedRecon,
    looks_like_spec,
    parse_recon_file,
    recon_stubs,
)
from app.recon_prompt import build_recon_prompt

ПЕРЕЧЕНЬ = """# archmap-recon
node: Zulip / backend
operations:
  - GET /messages
  - POST /messages
workers:
  - email_senders
sources:
  - "операции: zerver/lib/rest.py (187 вхождений rest_path)"
doubts:
  - "GET /internal/metrics — похоже на служебный, не уверен"
"""

СПЕКА = """openapi: 3.0.0
info:
  title: API
paths:
  /messages:
    get:
      summary: список
"""


def _разбор(текст: str) -> ParsedRecon:
    parsed = parse_recon_file(текст)
    assert parsed is not None
    return parsed


# ── Опознание файла (Р8) ──────────────────────────────────────────────────────
def test_перечень_разбирается():
    p = _разбор(ПЕРЕЧЕНЬ)
    assert p.node_ref == "Zulip / backend"
    assert p.operations == ["GET /messages", "POST /messages"]
    assert p.workers == ["email_senders"]
    assert p.doubts == ["GET /internal/metrics — похоже на служебный, не уверен"]
    assert p.salvaged is False


def test_образец_промпта_разбирается():
    """Образец из промпта разведки обязан пройти приёмник как есть.

    Промпт — замеренный артефакт, и подстраивается под него приёмник, а не наоборот
    (санкция ТЗ Ф1). Заодно проверяется снос ограждения: пример в промпте обёрнут в
    ```yaml, и вырезать его умеет тот же механизм, что принимает ответ агента.
    """
    p = _разбор(build_recon_prompt("Zulip / backend"))
    assert p.node_ref == "Zulip / backend"
    assert p.operations == ["GET /messages", "POST /messages", "PATCH /messages/{message_id}"]
    assert p.workers == ["email_senders", "missedmessage_emails"]
    assert p.doubts and p.salvaged is False


def test_корневой_комментарий_необязателен():
    """«# archmap-recon» — комментарий, и агент его потеряет; перечнем файл остаётся."""
    p = _разбор("operations:\n  - GET /health\n")
    assert p.operations == ["GET /health"]
    # И наоборот: одних воркеров тоже достаточно (сервис без HTTP — законный случай).
    assert _разбор("workers:\n  - digest_emails\n").workers == ["digest_emails"]


def test_спека_перечнем_не_считается():
    assert parse_recon_file(СПЕКА) is None
    assert looks_like_spec(СПЕКА) is True


def test_чужие_файлы_пакета_пропускаются():
    """Рядом в папке лежат схемы логики и структура данных — их смотрит другой
    разборщик, и перечнем они не притворяются."""
    assert parse_recon_file("flowchart TD\n  A --> B\n") is None
    assert parse_recon_file("# archmap-node: Хранилище\ntables:\n  - name: orders\n") is None
    assert looks_like_spec("flowchart TD\n  A --> B\n") is False


# ── Толерантность разбора (Р7) ────────────────────────────────────────────────
def test_ограждение_снимается():
    p = _разбор("Вот перечень:\n\n```yaml\n" + ПЕРЕЧЕНЬ + "```\n")
    assert p.operations == ["GET /messages", "POST /messages"]
    assert p.node_ref == "Zulip / backend"


def test_битый_yaml_разбирается_построчно():
    """Двоеточие в имени объекта роняет разбор ВСЕГО документа — остальные строки целы,
    и терять их нельзя."""
    p = _разбор(
        "# archmap-recon\n"
        "node: Zulip: сервер / backend\n"
        "operations:\n"
        "  - GET /messages\n"
        "  - POST /messages\n"
        "workers:\n"
        "  - email_senders\n"
        "sources:\n"
        "  - операции: rest.py (187 вхождений)\n"
    )
    assert p.salvaged is True
    assert p.node_ref == "Zulip: сервер / backend"
    assert p.operations == ["GET /messages", "POST /messages"]
    # Раздел sources закрывает предыдущий: его строки в перечень не уезжают.
    assert p.workers == ["email_senders"]


def test_построчный_разбор_снимает_кавычки_и_комментарии():
    p = _разбор(
        "node: A: B\n"
        "operations:\n"
        '  - "GET /messages"  # служебный\n'
        "  -\n"
    )
    assert p.salvaged is True
    assert p.operations == ["GET /messages"]


def test_съеденное_двоеточие_не_теряет_строку():
    """«- GET /x: latest» YAML читает словарём — строку собираем обратно, а не выносим."""
    p = _разбор("operations:\n  - GET /messages: latest\n")
    assert p.operations == ["GET /messages: latest"]


def test_строка_операции_не_обязана_быть_http():
    """gRPC и GraphQL дают другие формы — отбраковка по шаблону «МЕТОД /путь» потеряла
    бы реальные точки входа молча."""
    p = _разбор(
        "operations:\n"
        "  - zulip.Messages/Send\n"
        "  - mutation createMessage\n"
        "  - POST /v1/files:upload\n"
    )
    assert p.operations == [
        "zulip.Messages/Send",
        "mutation createMessage",
        "POST /v1/files:upload",
    ]


# ── Строки → заглушки (Р11) ───────────────────────────────────────────────────
def test_заглушки_из_строк():
    stubs, warnings, errors = recon_stubs(_разбор(ПЕРЕЧЕНЬ))
    assert not errors
    assert [(s.name, s.kind, s.operation) for s in stubs] == [
        ("GET /messages", "operation", "GET /messages"),
        ("POST /messages", "operation", "POST /messages"),
        # Воркеру operation не положен: поле означает операцию спеки, а адрес воркера
        # — имя очереди.
        ("email_senders", "worker", None),
    ]
    assert any("сомнение разведчика" in w for w in warnings)


def test_пустые_и_дубли_схлопываются():
    stubs, warnings, _ = recon_stubs(
        ParsedRecon(
            operations=["GET /a", "GET /a", "  ", "GET /b"],
            # Строка и в операциях, и в воркерах — имя схемы уникально в пределах узла,
            # запись обеими уронила бы применение.
            workers=["GET /b", "digest"],
        )
    )
    assert [s.name for s in stubs] == ["GET /a", "GET /b", "digest"]
    assert any("пустых строк перечня пропущено: 1" in w for w in warnings)
    assert any("повторов строк перечня схлопнуто: 2" in w for w in warnings)


def test_длинная_строка_не_создаётся():
    """Молча обрезать нельзя: обрезанный адрес не сойдётся с операцией никогда."""
    длинная = "GET /" + "x" * MAX_ENTRY_LEN
    stubs, warnings, errors = recon_stubs(ParsedRecon(operations=[длинная, "GET /ok"]))
    assert [s.name for s in stubs] == ["GET /ok"]
    assert not errors
    assert any("заглушка не создана" in w for w in warnings)


def test_потолок_строк_блокирует_перечень():
    parsed = ParsedRecon(operations=[f"GET /op{i}" for i in range(MAX_RECON_LINES + 1)])
    stubs, _, errors = recon_stubs(parsed)
    assert stubs == []
    assert errors and str(MAX_RECON_LINES) in errors[0]
    # Ровно потолок — ещё перечень (Zulip с его 212 строками должен проходить с запасом).
    stubs, _, errors = recon_stubs(
        ParsedRecon(operations=[f"GET /op{i}" for i in range(MAX_RECON_LINES)])
    )
    assert len(stubs) == MAX_RECON_LINES and not errors


def test_спасённый_файл_помечен_замечанием():
    _, warnings, _ = recon_stubs(ParsedRecon(operations=["GET /a"], salvaged=True))
    assert any("разобран построчно" in w for w in warnings)
