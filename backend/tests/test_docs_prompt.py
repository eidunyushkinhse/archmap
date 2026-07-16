"""Тесты промпта «Доки от агента» (docs_prompt, этап 2 plan-agent-docs.md).

Главная гарантия — пример манифеста из промпта проходит parse_manifest во всех
вариантах include (промпт не может протухнуть относительно формата). Плюс
маркеры критичных правил (уроки стресс-теста repo-import) и переключатели.
"""

from app.docs_import import parse_manifest
from app.docs_prompt import build_docs_prompt, example_manifest

SLICE = "nodes:\n- name: Ярмарка\n  shape: service\nedges: []\n"


def test_example_passes_validator_all_includes():
    for include in ("both", "logic", "api"):
        parsed, errors = parse_manifest(example_manifest(include))
        assert errors == [], (include, errors)
        assert parsed is not None and parsed.entries
        if include == "logic":
            assert all(e.openapi is None for e in parsed.entries)
        if include == "api":
            assert all(not e.logic for e in parsed.entries)
            assert all(e.openapi is not None for e in parsed.entries)


def test_example_teaches_conventions():
    text = example_manifest("both")
    # Двоеточие в имени схемы закавычено дампером — молчаливый урок кавычек
    assert '"Крон: выставление счетов"' in text
    # mermaid — литеральным блоком, подписи в ["…"]
    assert "mermaid: |" in text
    assert 'A["Приём запроса"]' in text
    # Обе формы адресации: полный путь и голое уникальное имя
    assert "node: Ярмарка / orders" in text
    assert "node: orders-db" in text


def test_prompt_markers_and_slice():
    prompt = build_docs_prompt(SLICE, include="both")
    assert SLICE.rstrip() in prompt  # срез вложен
    for marker in (
        "ДОСЛОВНО",
        "archmap-docs/manifest.yaml",
        "НЕ перепечатывай",
        "origin: found",
        "origin: synthesized",
        "graph TD",
        "двойные кавычки",
        "Схему НЕ меняй",
        "чью реализацию видишь в ЭТОМ репозитории",
    ):
        assert marker in prompt, marker


def test_prompt_include_toggles():
    logic_only = build_docs_prompt(SLICE, include="logic")
    assert "Схемы логики (logic)" in logic_only
    assert "OpenAPI-спека (openapi)" not in logic_only
    assert "origin" not in logic_only.split("## Формат результата")[0].split("## Срез")[1]

    api_only = build_docs_prompt(SLICE, include="api")
    assert "OpenAPI-спека (openapi)" in api_only
    assert "Схемы логики (logic)" not in api_only


def test_prompt_lang_and_hints():
    en = build_docs_prompt(SLICE, include="both", lang="en", hints="Только сервис billing")
    assert "английский (English)" in en
    assert "Пример ниже написан по-русски" in en
    assert "Дополнительные указания пользователя" in en
    assert "Только сервис billing" in en

    ru = build_docs_prompt(SLICE)
    assert "Пример ниже написан по-русски" not in ru
    assert "Дополнительные указания" not in ru
