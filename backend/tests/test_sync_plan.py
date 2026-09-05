"""Тесты плана синхронизации (app/sync_plan.py, Фаза 1 docs/plan-arch-sync.md).

Ключевое, что здесь проверяется:
  • ФИКСПОЙНТ — прогон, из которого схема и создавалась, даёт пустой план
    (иначе синк генерировал бы фантомный diff на ровном месте);
  • переименование сервиса при том же якоре — update, а НЕ create + missing
    (ради этого делалась Фаза 0);
  • тёзка с противоречащим якорем не захватывает чужой узел;
  • консервативные дефолты: проза и имена не трогаются, компоненты вне синка,
    удалений нет — пропажа лишь помечается действием missing.
"""

import uuid

from app.import_yaml import ParsedImport, parse_import
from app.models.edge import Edge
from app.models.node import Node
from app.sync_plan import SyncPolicies, build_sync_plan


def _parse(text: str) -> ParsedImport:
    parsed, errors = parse_import(text)
    assert errors == [], errors
    return parsed


def _seed(parsed: ParsedImport) -> tuple[list[Node], list[Edge]]:
    """Живая схема, созданная ЭТИМ же прогоном (зеркало seed_import без БД)."""
    nodes: list[Node] = []
    for n in parsed.nodes:
        nodes.append(
            Node(
                id=uuid.uuid4(),
                project_id=uuid.uuid4(),
                name=n.name,
                description=n.description,
                role=n.role,
                technology=n.technology,
                shape=n.shape,
                status=n.status,
                is_external=n.is_external,
                source_ref=n.source_keys[0] if n.source_keys else None,
                parent_id=nodes[n.parent_idx].id if n.parent_idx is not None else None,
            )
        )
    edges = [
        Edge(
            id=uuid.uuid4(),
            project_id=nodes[0].project_id,
            source_id=nodes[e.source_idx].id,
            target_id=nodes[e.target_idx].id,
            label=e.label,
            technology=e.technology,
        )
        for e in parsed.edges
    ]
    return nodes, edges


def _by_action(plan, action: str) -> list[str]:
    return [a.path for a in plan.nodes if a.action == action]


RUN = """
nodes:
  - name: Система
    children:
      - name: payments
        role: сервис
        source: {repo: github.com/org/payments, host: payments}
      - name: orders
        source: {repo: github.com/org/orders, host: orders}
      - name: orders-db
        shape: database
        source: {host: orders-db}
edges:
  - {from: orders, to: payments, label: платит}
  - {from: orders, to: orders-db, label: хранит}
"""


class TestFixpoint:
    def test_повторный_прогон_не_меняет_ничего(self):
        """Главный критерий фазы: схема создана этим прогоном — план пуст."""
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        plan = build_sync_plan(nodes, edges, parsed)

        assert plan.is_noop, plan.summary
        assert plan.summary == {"nodes_unchanged": 4, "edges_unchanged": 2}
        assert plan.conflicts == [] and plan.warnings == []

    def test_фикспойнт_держится_и_при_всех_включённых_политиках(self):
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        policies = SyncPolicies(
            update_descriptions=True,
            update_names=True,
            sync_components=True,
            mark_missing_deprecated=True,
        )
        assert build_sync_plan(nodes, edges, parsed, policies).is_noop


class TestIdentity:
    def test_переименование_при_том_же_якоре_это_update(self):
        """Сервис переименовали — якорь держит тождество. Без Фазы 0 здесь были бы
        create + missing, то есть узел потерял бы раскладку, схемы логики и спеку."""
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        # Переименовать нужно и ссылку в ребре, иначе YAML просто не разберётся.
        renamed = _parse(RUN.replace("name: payments", "name: billing").replace("to: payments", "to: billing"))

        plan = build_sync_plan(nodes, edges, renamed)

        assert _by_action(plan, "create") == [] and _by_action(plan, "missing") == []
        act = next(a for a in plan.nodes if a.path.endswith("billing"))
        assert act.action == "unchanged" and act.matched_by == "code"
        # Переименование ВИДНО, но по умолчанию не применяется.
        assert any("назван «billing»" in c and "оставляем как есть" in c for c in plan.conflicts)

    def test_переименование_применяется_по_политике(self):
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        # Переименовать нужно и ссылку в ребре, иначе YAML просто не разберётся.
        renamed = _parse(RUN.replace("name: payments", "name: billing").replace("to: payments", "to: billing"))

        plan = build_sync_plan(nodes, edges, renamed, SyncPolicies(update_names=True))

        act = next(a for a in plan.nodes if a.path.endswith("billing"))
        assert act.action == "update" and act.fields == ["name"]

    def test_тёзка_из_другого_источника_не_захватывает_узел(self):
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        alien = _parse(
            "nodes:\n"
            "  - name: Система\n"
            "    children:\n"
            "      - name: payments\n"
            "        source: {repo: github.com/other-team/payments}\n"
        )
        plan = build_sync_plan(nodes, edges, alien)

        assert _by_action(plan, "create") == ["Система / payments"]
        assert any("уже есть объект с таким именем" in w for w in plan.warnings)

    def test_первый_синк_заякоривает_узлы_без_source_ref(self):
        """Схема из старого прогона (якорей не было): матч идёт по имени, а план
        проставляет source_ref — со следующего раза узлы держит якорь."""
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        for n in nodes:
            n.source_ref = None

        plan = build_sync_plan(nodes, edges, parsed)

        act = next(a for a in plan.nodes if a.path.endswith("payments"))
        assert act.action == "update" and act.fields == ["source_ref"]
        assert act.matched_by == "name" and act.source_ref == "git:github.com/org/payments"


class TestConservativeDefaults:
    def test_проза_по_умолчанию_не_трогается(self):
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        for n in nodes:
            n.description = "Описание, выправленное руками"
        wordy = _parse(RUN.replace("role: сервис", 'role: сервис\n        description: "Проза прогона"'))

        assert build_sync_plan(nodes, edges, wordy).is_noop
        plan = build_sync_plan(nodes, edges, wordy, SyncPolicies(update_descriptions=True))
        act = next(a for a in plan.nodes if a.path.endswith("payments"))
        assert act.action == "update" and act.fields == ["description"]

    def test_пустое_поле_доливается_а_занятое_нет(self):
        """«Богатое побеждает»: technology проставится, роль — нет, её правил человек."""
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        live = next(n for n in nodes if n.name == "payments")
        live.role = "платёжный шлюз"  # ручная правка
        live.technology = None
        richer = _parse(RUN.replace("role: сервис", "role: сервис\n        technology: Go"))

        plan = build_sync_plan(nodes, edges, richer)
        act = next(a for a in plan.nodes if a.path.endswith("payments"))
        assert act.fields == ["technology"]

    def test_компоненты_вне_синка_по_умолчанию(self):
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        deep = _parse(RUN.replace(
            "      - name: orders\n",
            "      - name: orders\n        children:\n          - name: api\n",
        ))
        assert build_sync_plan(nodes, edges, deep).is_noop

        plan = build_sync_plan(nodes, edges, deep, SyncPolicies(sync_components=True))
        assert _by_action(plan, "create") == ["Система / orders / api"]

    def test_пропавший_узел_помечается_а_не_удаляется(self):
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        without = _parse(
            RUN.replace("      - name: orders-db\n        shape: database\n        source: {host: orders-db}\n", "")
            .replace("  - {from: orders, to: orders-db, label: хранит}\n", "")
        )

        plan = build_sync_plan(nodes, edges, without)

        assert _by_action(plan, "missing") == ["Система / orders-db"]
        # Связь в пропавший узел НЕ объявляется пропавшей: узел не удаляется
        # (максимум помечается deprecated), значит связь в него остаётся живой.
        assert [e for e in plan.edges if "orders-db" in e.target_path] == []

    def test_пропавшая_связь_между_живыми_узлами_видна(self):
        """А вот связь, исчезнувшая между узлами, которые прогон показал, —
        настоящая пропажа, и она в плане (путями, а не голыми именами)."""
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        without_edge = _parse(RUN.replace("  - {from: orders, to: payments, label: платит}\n", ""))

        plan = build_sync_plan(nodes, edges, without_edge)

        missing = [(e.source_path, e.target_path) for e in plan.edges if e.action == "missing"]
        assert missing == [("Система / orders", "Система / payments")]

    def test_переезд_узла_не_выполняется(self):
        """Прогон положил сервис под другого родителя — поддерево не перевешиваем."""
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        moved = _parse("""
nodes:
  - name: Система
    children:
      - name: orders
        source: {repo: github.com/org/orders, host: orders}
        children:
          - name: payments
            source: {repo: github.com/org/payments, host: payments}
""")
        plan = build_sync_plan(nodes, edges, moved, SyncPolicies(sync_components=True))

        assert any("показан в другом месте" in c for c in plan.conflicts)
        act = next(a for a in plan.nodes if a.path.endswith("payments"))
        assert act.action == "unchanged" and act.node_id is not None


class TestEdges:
    def test_новая_связь_и_новый_узел(self):
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        grown = _parse(RUN.replace(
            "edges:",
            "      - name: cache\n        source: {host: cache}\nedges:\n  - {from: payments, to: cache, label: кэширует}",
        ))
        plan = build_sync_plan(nodes, edges, grown)

        assert _by_action(plan, "create") == ["Система / cache"]
        created = [(e.source_path, e.target_path) for e in plan.edges if e.action == "create"]
        assert created == [("Система / payments", "Система / cache")]


# ── Эндпоинт POST /projects/{id}/sync/preview ─────────────────────────────────


def test_sync_preview_endpoint(db):
    """Полный путь через роутер: проект создан импортом, тот же прогон синка даёт
    пустой план (фикспойнт), а изменённый — конкретные действия. Записи нет."""
    from conftest import ensure_architect, seed_project_from_yaml

    from app.routers.projects import sync_preview
    from app.schemas.project import SyncPreviewIn

    user = ensure_architect(db)
    p = seed_project_from_yaml(db, [RUN])

    same = sync_preview(p.id, SyncPreviewIn(contents=[RUN]), db=db, _user=user)
    assert same.ok and same.is_noop
    assert same.summary == {"nodes_unchanged": 4, "edges_unchanged": 2}

    grown = RUN.replace(
        "edges:",
        "      - name: cache\n        source: {host: cache}\nedges:\n  - {from: payments, to: cache, label: кэширует}",
    )
    plan = sync_preview(p.id, SyncPreviewIn(contents=[grown]), db=db, _user=user)
    assert plan.ok and not plan.is_noop
    assert [a.path for a in plan.nodes if a.action == "create"] == ["Система / cache"]
    assert plan.summary["edges_create"] == 1
    # Ничего не записано: схема осталась прежней.
    assert db.query(Node).filter(Node.project_id == p.id).count() == 4
    # Ф2 якорей: ответ роутера несёт основание матча и РАЗОБРАННЫЙ якорь — по ним
    # превью говорит «нашли по коду …» и «якорь: имя зависимости …».
    по_пути = {a.path: a for a in plan.nodes}
    assert по_пути["Система / payments"].matched_by == "code"
    assert по_пути["Система / payments"].source is not None
    assert по_пути["Система / payments"].source.repo == "github.com/org/payments"
    assert по_пути["Система / orders-db"].matched_by == "dependency"
    новый = по_пути["Система / cache"]
    assert новый.action == "create" and новый.matched_by is None
    assert новый.source is not None and новый.source.host == "cache"
    assert по_пути["Система"].source is None  # у корня якоря нет


def test_sync_preview_broken_yaml_and_404(db):
    from conftest import ensure_architect, seed_project_from_yaml

    from app.routers.projects import sync_preview
    from app.schemas.project import SyncPreviewIn

    user = ensure_architect(db)
    p = seed_project_from_yaml(db, [RUN], name="Проект")

    bad = sync_preview(p.id, SyncPreviewIn(contents=["nodes: [oops"]), db=db, _user=user)
    assert not bad.ok and bad.errors and bad.nodes == []

    import pytest
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        sync_preview(uuid.uuid4(), SyncPreviewIn(contents=[RUN]), db=db, _user=user)
    assert exc.value.status_code == 404


# ── возврат статуса вернувшемуся узлу (проверка-2 №1) ─────────────────────────

_RETURN_YAML = "nodes:\n- name: Система\n  children:\n  - name: seed-data\nedges: []\n"


def _schema_with_deprecated_seed() -> tuple[list[Node], list[Edge]]:
    """Схема из того же YAML, но seed-data помечен устаревшим (его «не было» в
    прошлом прогоне, и синк поставил статус)."""
    nodes, edges = _seed(_parse(_RETURN_YAML))
    next(n for n in nodes if n.name == "seed-data").status = "deprecated"
    return nodes, edges


def test_вернувшийся_узел_виден_в_плане_даже_когда_статус_не_трогаем():
    # Раньше такой узел попадал в unchanged и не упоминался в плане ни строкой:
    # правило «не-дефолт бьёт дефолт» не пропускало обратный переход.
    nodes, edges = _schema_with_deprecated_seed()

    plan = build_sync_plan(nodes, edges, _parse(_RETURN_YAML), SyncPolicies())

    act = next(a for a in plan.nodes if a.path.endswith("seed-data"))
    assert act.returned is True
    assert act.action == "unchanged"  # статус не трогаем без галочки
    assert "status" not in act.fields
    assert plan.summary.get("nodes_returned") == 1


def test_галочка_возвращает_статус():
    nodes, edges = _schema_with_deprecated_seed()

    plan = build_sync_plan(
        nodes, edges, _parse(_RETURN_YAML), SyncPolicies(restore_returned=True)
    )

    act = next(a for a in plan.nodes if a.path.endswith("seed-data"))
    assert act.returned is True and act.action == "update" and "status" in act.fields


def test_обычный_узел_вернувшимся_не_считается():
    nodes, edges = _seed(_parse(_RETURN_YAML))

    plan = build_sync_plan(
        nodes, edges, _parse(_RETURN_YAML), SyncPolicies(restore_returned=True)
    )

    act = next(a for a in plan.nodes if a.path.endswith("seed-data"))
    assert act.returned is False and act.action == "unchanged"


# ── Основание матча словами и якорь действия (Ф2 docs/plan-anchor-ux.md) ─────


class TestMatchBasis:
    """План называет, ЧЕМ опознан каждый живой узел, — словарём двух видов якоря.

    Значений ровно три: «code» (сошёлся репозиторий), «dependency» (имя
    зависимости) и «name» (якорей нет, решило имя внутри смэтченного родителя)."""

    def test_три_основания_в_одном_прогоне(self):
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        # «orders-db» знает только имя зависимости, у корня якоря нет вовсе.
        plan = build_sync_plan(nodes, edges, parsed)

        основания = {a.path: a.matched_by for a in plan.nodes if a.action != "missing"}
        assert основания == {
            "Система": "name",
            "Система / payments": "code",
            "Система / orders": "code",
            "Система / orders-db": "dependency",
        }

    def test_якорь_действия_разобран_в_контракт(self):
        """Строке «якорь: код …» нужен разобранный source, а не технический ключ."""
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        plan = build_sync_plan(nodes, edges, parsed)

        по_пути = {a.path: a.source_ref for a in plan.nodes}
        assert по_пути["Система / payments"] == "git:github.com/org/payments"
        assert по_пути["Система / orders-db"] == "host:orders-db"
        assert по_пути["Система"] is None  # у корня якоря нет — опознают по имени

    def test_тексты_называют_вид_якоря_словами(self):
        """Хвост Ф0: план звал якорь «репозиторию» и «сетевому имени» — словами
        снятой модели. Теперь — «коду» и «имени зависимости», как везде."""
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        renamed = _parse(
            RUN.replace("name: payments", "name: billing").replace("to: payments", "to: billing")
        )

        plan = build_sync_plan(nodes, edges, renamed)

        строка = next(c for c in plan.conflicts if "billing" in c)
        assert "узнали по коду github.com/org/payments" in строка
        assert "репозитор" not in строка

    def test_текст_тёзки_называет_имя_зависимости(self):
        """Тот же словарь в предупреждении о тёзке с противоречащим якорем."""
        parsed = _parse(RUN)
        nodes, edges = _seed(parsed)
        alien = _parse(
            "nodes:\n"
            "  - name: Система\n"
            "    children:\n"
            "      - name: orders-db\n"
            "        source: {host: other-db}\n"
        )
        plan = build_sync_plan(nodes, edges, alien)

        предупреждение = next(w for w in plan.warnings if "orders-db" in w)
        assert "относится к другому имени зависимости orders-db" in предупреждение
        assert "сетевому имени" not in предупреждение
