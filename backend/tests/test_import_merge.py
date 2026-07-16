"""Тесты слияния нескольких импортов (app/import_merge.py).

Матрица: заглушка+богатый (поля доливаются, дети объединяются), конфликты полей
(первое побеждает + строка в отчёт), external → true, не-дефолт бьёт дефолт,
перевес рёбер + дедуп точных дублей, предупреждения (похожие подписи пары из
разных файлов, fuzzy-имена сиблингов, несовпавшие корни), passthrough одного
файла, нечувствительность к порядку файлов, суммарные лимиты, инвариант
«родители раньше детей» (совместимость с seed_import).
"""

from app.import_merge import merge_imports
from app.import_yaml import ParsedImport, parse_import


def _parse(text: str) -> ParsedImport:
    parsed, errors = parse_import(text)
    assert errors == [], errors
    return parsed


def _path_list(p: ParsedImport) -> list[str]:
    out: list[str] = []
    for n in p.nodes:
        out.append(n.name if n.parent_idx is None else f"{out[n.parent_idx]} / {n.name}")
    return out


def _node_by_path(p: ParsedImport, path: str):
    idx = _path_list(p).index(path)
    return p.nodes[idx]


def _edge_sig(p: ParsedImport) -> set[tuple]:
    paths = _path_list(p)
    return {
        (paths[e.source_idx], paths[e.target_idx], e.label, e.technology) for e in p.edges
    }


# Два «репозитория» одной системы: payments богат в A и заглушка в B, orders —
# наоборот; общий корень, ребро orders→payments есть в обоих файлах (дубль).
FILE_A = """
nodes:
  - name: Ярмарка
    role: система
    children:
      - name: payments
        technology: Python
        description: Сервис платежей
        children:
          - name: api
            role: компонент
          - name: charge-worker
            role: воркер
      - name: payments-db
        shape: database
        technology: PostgreSQL
      - name: orders
  - name: Stripe
    external: true
edges:
  - from: payments
    to: payments-db
    label: хранит
  - from: payments
    to: Stripe
    label: charge
  - from: orders
    to: payments
    label: REST
"""

FILE_B = """
nodes:
  - name: Ярмарка
    role: система
    children:
      - name: orders
        technology: Go
        description: Сервис заказов
        children:
          - name: checkout
            role: компонент
      - name: orders-db
        shape: database
        technology: PostgreSQL
      - name: payments
edges:
  - from: orders
    to: orders-db
    label: хранит
  - from: orders
    to: payments
    label: REST
"""


def test_stub_plus_rich_merge():
    """Заглушки доливаются богатыми версиями из «родных» файлов, дети объединяются,
    точный дубль ребра выброшен, конфликтов нет."""
    merged, report = merge_imports([_parse(FILE_A), _parse(FILE_B)])
    paths = set(_path_list(merged))
    assert paths == {
        "Ярмарка",
        "Ярмарка / payments",
        "Ярмарка / payments / api",
        "Ярмарка / payments / charge-worker",
        "Ярмарка / payments-db",
        "Ярмарка / orders",
        "Ярмарка / orders / checkout",
        "Ярмарка / orders-db",
        "Stripe",
    }
    pay = _node_by_path(merged, "Ярмарка / payments")
    assert pay.technology == "Python" and pay.description == "Сервис платежей"
    ords = _node_by_path(merged, "Ярмарка / orders")
    assert ords.technology == "Go" and ords.description == "Сервис заказов"
    assert set(report.merged_paths) == {"Ярмарка", "Ярмарка / payments", "Ярмарка / orders"}
    assert report.dropped_edges == 1
    assert len(merged.edges) == 4
    assert report.conflicts == [] and report.errors == []
    # предупреждений о fuzzy нет: payments/payments-db жили в одном файле
    assert report.warnings == []


def test_order_insensitive_semantics():
    """Набор узлов и рёбер не зависит от порядка файлов."""
    ab, _ = merge_imports([_parse(FILE_A), _parse(FILE_B)])
    ba, _ = merge_imports([_parse(FILE_B), _parse(FILE_A)])
    assert set(_path_list(ab)) == set(_path_list(ba))
    assert _edge_sig(ab) == _edge_sig(ba)


def test_field_conflict_first_wins():
    a = _parse("nodes:\n  - name: svc\n    technology: Python\n")
    b = _parse("nodes:\n  - name: svc\n    technology: Go\n")
    merged, report = merge_imports([a, b])
    assert merged.nodes[0].technology == "Python"
    assert len(report.conflicts) == 1
    assert "technology" in report.conflicts[0]
    assert "файл 2" in report.conflicts[0]


def test_external_disagreement_becomes_true():
    a = _parse("nodes:\n  - name: Stripe\n    external: true\n")
    b = _parse("nodes:\n  - name: Stripe\n")
    merged, report = merge_imports([a, b])
    assert merged.nodes[0].is_external is True
    assert any("external" in c for c in report.conflicts)


def test_enum_non_default_beats_default_and_conflicts():
    # дефолтный shape (service) уступает database без конфликта
    a = _parse("nodes:\n  - name: cache\n")
    b = _parse("nodes:\n  - name: cache\n    shape: database\n")
    merged, report = merge_imports([a, b])
    assert merged.nodes[0].shape == "database"
    assert report.conflicts == []
    # два разных не-дефолта — конфликт, первое побеждает
    c = _parse("nodes:\n  - name: cache\n    shape: broker\n")
    d = _parse("nodes:\n  - name: cache\n    shape: database\n")
    merged2, report2 = merge_imports([c, d])
    assert merged2.nodes[0].shape == "broker"
    assert any("shape" in x for x in report2.conflicts)


def test_same_pair_different_labels_warns():
    a = _parse("nodes:\n  - name: a\n  - name: b\nedges:\n  - from: a\n    to: b\n    label: REST\n")
    b = _parse("nodes:\n  - name: a\n  - name: b\nedges:\n  - from: a\n    to: b\n    label: gRPC\n")
    merged, report = merge_imports([a, b])
    assert len(merged.edges) == 2  # оба ребра сохранены
    assert any("разные подписи" in w for w in report.warnings)


def test_fuzzy_siblings_warn_not_merge():
    a = _parse("nodes:\n  - name: Система\n    children:\n      - name: payments\n")
    b = _parse("nodes:\n  - name: Система\n    children:\n      - name: payments-service\n")
    merged, report = merge_imports([a, b])
    paths = set(_path_list(merged))
    # НЕ склеены — оба существуют
    assert "Система / payments" in paths and "Система / payments-service" in paths
    assert any("похожи" in w for w in report.warnings)


def test_roots_mismatch_warns():
    a = _parse("nodes:\n  - name: Система A\n")
    b = _parse("nodes:\n  - name: Система B\n")
    merged, report = merge_imports([a, b])
    assert len(merged.roots) == 2
    assert any("не совпали" in w for w in report.warnings)


def test_single_file_passthrough():
    a = _parse(FILE_A)
    merged, report = merge_imports([a])
    assert merged is a
    assert report.files == 1
    assert report.merged_paths == [] and report.conflicts == [] and report.warnings == []


def test_total_limit_overflow():
    def big(prefix: str) -> ParsedImport:
        lines = "\n".join(f"  - name: {prefix}{i}" for i in range(1200))
        return _parse("nodes:\n" + lines + "\n")

    _, report = merge_imports([big("a"), big("b")])
    assert any("слишком много узлов" in e.lower() for e in report.errors)


def test_parents_before_children_invariant():
    """Совместимость с seed_import: родитель всегда раньше ребёнка в списке."""
    merged, _ = merge_imports([_parse(FILE_B), _parse(FILE_A)])
    for i, n in enumerate(merged.nodes):
        assert n.parent_idx is None or n.parent_idx < i
