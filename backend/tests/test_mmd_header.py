"""Разбор шапки .mmd (app/mmd_header.py).

Ключевой тест — «пример из промпта разбирается»: пример хранится данными и
парсится обратно, поэтому промпт не может разойтись с парсером. Разъезд означал
бы, что агент честно пишет шапку, а мы её молча не читаем.
"""

from app.mmd_header import MmdHeader, example_mmd, fix_broken_diamonds, parse_mmd_header


def test_пример_для_промпта_разбирается_обратно() -> None:
    h = parse_mmd_header(example_mmd())

    assert h.name == "Приём заказа"
    assert h.kind == "operation"
    assert h.operation == "POST /orders"
    assert h.problems == []


def test_без_шапки_всё_пусто_и_без_замечаний() -> None:
    h = parse_mmd_header("graph TD\n  A --> B\n")

    assert h == MmdHeader()
    assert h.is_empty


def test_директива_mermaid_не_прячет_шапку() -> None:
    # «%%{init: …}%%» — это ДИРЕКТИВА, а не комментарий: она законно стоит перед
    # диаграммой, и сканирование на ней прерываться не должно.
    text = '%%{init: {"theme": "dark"}}%%\n%% archmap-name: Схема хранения\ngraph LR\n  T1 --> T2\n'

    h = parse_mmd_header(text)

    assert h.name == "Схема хранения"
    assert h.problems == []


def test_чужой_комментарий_игнорируется() -> None:
    h = parse_mmd_header("%% сгенерировано агентом\n%% archmap-kind: worker\ngraph TD\n  A --> B\n")

    assert h.kind == "worker"
    assert h.problems == []


def test_шапка_после_начала_диаграммы_не_читается() -> None:
    # Комментарий посреди диаграммы — часть схемы, а не её паспорт.
    h = parse_mmd_header("graph TD\n  A --> B\n%% archmap-name: Поздно\n")

    assert h.name is None


def test_frontmatter_пропускается_шапка_за_ним_читается() -> None:
    text = "---\ntitle: Заказы\n---\n%% archmap-name: Приём заказа\ngraph TD\n  A --> B\n"

    assert parse_mmd_header(text).name == "Приём заказа"


def test_двоеточие_внутри_значения_сохраняется() -> None:
    # И в имени схемы, и в операции двоеточия законны — режем по ПЕРВОМУ.
    text = "%% archmap-name: Крон: выставление счетов\n%% archmap-operation: POST /orders\ngraph TD\n A-->B\n"

    h = parse_mmd_header(text)

    assert h.name == "Крон: выставление счетов"
    assert h.operation == "POST /orders"


def test_адрес_узла_читается() -> None:
    h = parse_mmd_header("%% archmap-node: Ярмарка / orders-db\ngraph LR\n T1 --> T2\n")

    assert h.node == "Ярмарка / orders-db"


def test_неизвестное_поле_попадает_в_замечания() -> None:
    h = parse_mmd_header("%% archmap-namee: Опечатка\ngraph TD\n A-->B\n")

    assert h.name is None
    assert len(h.problems) == 1
    assert "namee" in h.problems[0]


def test_неизвестный_вид_не_принимается_молча() -> None:
    h = parse_mmd_header("%% archmap-kind: диаграмма\ngraph TD\n A-->B\n")

    assert h.kind is None
    assert h.problems and "диаграмма" in h.problems[0]


def test_пустое_значение_это_замечание() -> None:
    h = parse_mmd_header("%% archmap-name:\ngraph TD\n A-->B\n")

    assert h.name is None
    assert h.problems


def test_виндовые_переводы_строк_и_bom() -> None:
    text = "﻿%% archmap-name: Приём заказа\r\n%% archmap-kind: operation\r\ngraph TD\r\n A-->B\r\n"

    h = parse_mmd_header(text)

    assert h.name == "Приём заказа"
    assert h.kind == "operation"


def test_вид_приводится_к_нижнему_регистру() -> None:
    assert parse_mmd_header("%% archmap-kind: Worker\ngraph TD\n A-->B\n").kind == "worker"


def test_шапка_с_замечанием_не_считается_пустой() -> None:
    # is_empty отвечает на «шапки не было», а не на «шапку не разобрали»: во
    # втором случае пользователю есть что показать.
    h = parse_mmd_header("%% archmap-namee: Опечатка\ngraph TD\n A-->B\n")

    assert not h.is_empty


def test_ромб_с_непарной_скобкой_чинится() -> None:
    # Полевые формы из замеров docs-quality (k3 zulip/a, k2b zabbix/a).
    text = (
        'graph TD\n'
        '  G --> H{"Клиент зеркалирует<br>сообщения?"]\n'
        '  H -- да --> I["Сохранить"]\n'
        '  AX{"Сигнал<br>shutdown?"]\n'
    )
    fixed, n = fix_broken_diamonds(text)

    assert n == 2
    assert 'H{"Клиент зеркалирует<br>сообщения?"}' in fixed
    assert 'AX{"Сигнал<br>shutdown?"}' in fixed
    assert 'I["Сохранить"]' in fixed


def test_валидная_схема_не_меняется() -> None:
    text = example_mmd() + '  X{{"шестиугольник"}}\n  Y[("цилиндр")]\n  Z{"ромб"} --> W["шаг"]\n'

    assert fix_broken_diamonds(text) == (text, 0)
