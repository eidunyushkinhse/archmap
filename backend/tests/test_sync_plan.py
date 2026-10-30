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
                element=n.element,
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
            channel=e.channel,
            is_synchronous=e.is_synchronous,
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
        create + missing, то есть узел потерял бы раскладку, схемы логики и спецификацию."""
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


# Связи с брокером: одна пара ходит по двум топикам — по ребру на канал (конвенция
# промпта импорта). Репорт 2026-10-28: синк терял канал и не различал каналы пары.
BROKER_RUN = """
nodes:
  - name: Система
    children:
      - name: producer
        source: {host: producer}
      - name: consumer
        source: {host: consumer}
      - name: bus
        shape: broker
        source: {host: bus}
edges:
  - {from: producer, to: bus, label: публикует A, technology: AMQP, channel: topic.a}
  - {from: producer, to: bus, label: публикует B, technology: AMQP, channel: topic.b}
  - {from: bus, to: consumer, label: доставляет A, technology: AMQP, channel: topic.a, sync: false}
"""


def _edge_actions(plan) -> list[tuple[str, str, str]]:
    return [(e.source_path, e.target_path, e.action) for e in plan.edges]


class TestEdgeChannels:
    def test_фикспойнт_с_каналами(self):
        """Схема, созданная этим прогоном (импортом, с каналами), даёт пустой план —
        две связи одной пары не принимаются друг за друга."""
        parsed = _parse(BROKER_RUN)
        nodes, edges = _seed(parsed)
        plan = build_sync_plan(nodes, edges, parsed)
        assert plan.is_noop, _edge_actions(plan)

    def test_пустой_канал_заполняется_действием_update_по_подписи(self):
        """Проект, заполненный синком до фикса: связи есть, каналов нет. Повторный
        синк тех же файлов подбирает каждому ребру прогона живую связь пары по подписи
        и заполняет канал (и явный асинхронный тип) — не дублирует и не молчит."""
        parsed = _parse(BROKER_RUN)
        nodes, edges = _seed(parsed)
        by_label = {e.label: e for e in edges}
        for e in edges:
            e.channel = None
            e.is_synchronous = None

        plan = build_sync_plan(nodes, edges, parsed)

        assert [e.action for e in plan.edges] == ["update", "update", "update"]
        assert plan.summary["edges_update"] == 3 and not plan.is_noop
        fills = {e.edge_id: e.fields for e in plan.edges}
        assert fills[by_label["публикует A"].id] == ["channel"]
        assert fills[by_label["публикует B"].id] == ["channel"]
        assert fills[by_label["доставляет A"].id] == ["channel", "is_synchronous"]
        # imp_idx ведёт на ребро прогона с правильным каналом.
        a = next(e for e in plan.edges if e.edge_id == by_label["публикует A"].id)
        assert parsed.edges[a.imp_idx].channel == "topic.a"

    def test_заполненное_не_перезаписывается(self):
        """Канал и тип, которые уже стоят у живой связи, синк не трогает: явный
        sync: true у прогона — не повод писать «тип» в план (дефолт тот же)."""
        parsed = _parse(BROKER_RUN)
        nodes, edges = _seed(parsed)
        explicit = _parse(BROKER_RUN.replace("channel: topic.b}", "channel: topic.b, sync: true}"))
        assert build_sync_plan(nodes, edges, explicit).is_noop

    def test_новый_канал_той_же_пары_создаётся(self):
        """Второй топик между уже связанными сервисами — новая связь, а не «без
        изменений» (до фикса превью показывало её как существующую)."""
        parsed = _parse(BROKER_RUN)
        nodes, edges = _seed(parsed)
        grown = _parse(BROKER_RUN + "  - {from: producer, to: bus, label: публикует C, technology: AMQP, channel: topic.c}\n")

        plan = build_sync_plan(nodes, edges, grown)

        created = [e for e in plan.edges if e.action == "create"]
        assert [(e.source_path, e.target_path) for e in created] == [("Система / producer", "Система / bus")]
        assert grown.edges[created[0].imp_idx].channel == "topic.c"
        assert plan.summary == {"nodes_unchanged": 4, "edges_unchanged": 3, "edges_create": 1}

    def test_пропавшая_связь_пары_видна_даже_когда_другая_осталась(self):
        """Из кода ушёл один из двух топиков пары — именно он в «пропавших», вторая
        связь пары без изменений (до фикса в учёт попадала только первая связь пары)."""
        parsed = _parse(BROKER_RUN)
        nodes, edges = _seed(parsed)
        gone_b = next(e for e in edges if e.channel == "topic.b")
        without_b = _parse(BROKER_RUN.replace(
            "  - {from: producer, to: bus, label: публикует B, technology: AMQP, channel: topic.b}\n", ""
        ))

        plan = build_sync_plan(nodes, edges, without_b)

        missing = [e for e in plan.edges if e.action == "missing"]
        assert [e.edge_id for e in missing] == [gone_b.id]
        assert plan.summary["edges_unchanged"] == 2

    def test_другой_канал_это_другая_связь(self):
        """Канал — идентичность связи с брокером: прогон назвал другой топик —
        создаётся новая связь, старая показана пропавшей. Заполненный канал не
        перезаписывается молча (его могли поправить руками)."""
        parsed = _parse(BROKER_RUN)
        nodes, edges = _seed(parsed)
        renamed = _parse(BROKER_RUN.replace("channel: topic.b}", "channel: topic.b2}"))

        plan = build_sync_plan(nodes, edges, renamed)

        assert sorted(e.action for e in plan.edges) == ["create", "missing", "unchanged", "unchanged"]
        assert all(e.channel == "topic.b" for e in edges if e.id in {m.edge_id for m in plan.edges if m.action == "missing"})

    def test_ребро_без_канала_не_дублирует_живую_связь_с_каналом(self):
        """Агент в этот раз не нашёл имя канала (channel пуст): ребро прогона
        относится к живой связи пары, а не создаёт дубль без канала рядом с ней."""
        parsed = _parse(BROKER_RUN)
        nodes, edges = _seed(parsed)
        lost = _parse(BROKER_RUN.replace(", channel: topic.a, sync: false}", "}"))

        plan = build_sync_plan(nodes, edges, lost)

        assert plan.is_noop, _edge_actions(plan)

    def test_рёбра_с_каналом_разбираются_раньше_рёбер_без_канала(self):
        """Порядок рёбер в прогоне не меняет решения: ребро без канала, идущее
        первым, не забирает живую связь с каналом у своего настоящего ребра."""
        parsed = _parse(BROKER_RUN)
        nodes, edges = _seed(parsed)
        live_a = next(e for e in edges if e.label == "публикует A")
        reordered = _parse(BROKER_RUN.replace(
            "edges:\n",
            "edges:\n  - {from: producer, to: bus, label: публикует без имени, technology: AMQP}\n",
        ))

        plan = build_sync_plan(nodes, edges, reordered)

        a = next(e for e in plan.edges if reordered.edges[e.imp_idx].channel == "topic.a" and e.imp_idx is not None)
        assert (a.action, a.edge_id) == ("unchanged", live_a.id)
        nameless = plan.edges[0]
        assert reordered.edges[nameless.imp_idx].channel is None and nameless.action == "create"


# ── Эндпоинт POST /projects/{id}/sync/preview ─────────────────────────────────


def test_sync_preview_endpoint(db):
    """Полный путь через роутер: проект создан импортом, тот же прогон синка даёт
    пустой план (фикспойнт), а изменённый — конкретные действия. Записи нет."""
    from conftest import ensure_architect, seed_project_from_yaml

    from app.routers.projects import sync_preview
    from app.schemas.project import SyncPreviewIn

    user = ensure_architect(db)
    p = seed_project_from_yaml(db, [RUN])

    same = sync_preview(p.id, SyncPreviewIn(contents=[RUN]), db=db, user=user)
    assert same.ok and same.is_noop
    assert same.summary == {"nodes_unchanged": 4, "edges_unchanged": 2}

    grown = RUN.replace(
        "edges:",
        "      - name: cache\n        source: {host: cache}\nedges:\n  - {from: payments, to: cache, label: кэширует}",
    )
    plan = sync_preview(p.id, SyncPreviewIn(contents=[grown]), db=db, user=user)
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

    bad = sync_preview(p.id, SyncPreviewIn(contents=["nodes: [oops"]), db=db, user=user)
    assert not bad.ok and bad.errors and bad.nodes == []

    import pytest
    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        sync_preview(uuid.uuid4(), SyncPreviewIn(contents=[RUN]), db=db, user=user)
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


# ── Элемент архитектуры: синк — fill-only через правило (Ф2, Р30) ────────────

RUN_ЭЛЕМЕНТ = RUN.replace(
    "      - name: orders\n",
    "      - name: orders\n        element: container\n",
)


def _узел_плана(plan, path: str):
    return next(a for a in plan.nodes if a.path == path)


def test_элемент_пустой_живой_доливается():
    nodes, edges = _seed(_parse(RUN))
    plan = build_sync_plan(nodes, edges, _parse(RUN_ЭЛЕМЕНТ))

    orders = _узел_плана(plan, "Система / orders")
    assert (orders.action, orders.fields) == ("update", ["element"])
    assert plan.conflicts == []


def test_элемент_фикспойнт_план_пуст():
    nodes, edges = _seed(_parse(RUN_ЭЛЕМЕНТ))
    assert build_sync_plan(nodes, edges, _parse(RUN_ЭЛЕМЕНТ)).is_noop


def test_элемент_занятый_живой_не_трогается_строкой():
    """Решение человека синк не переписывает: другое значение в YAML — строка
    conflicts словами продукта, «не сказано» в YAML — ничего."""
    nodes, edges = _seed(_parse(RUN_ЭЛЕМЕНТ))
    plan = build_sync_plan(
        nodes, edges, _parse(RUN_ЭЛЕМЕНТ.replace("element: container", "element: system"))
    )
    assert _узел_плана(plan, "Система / orders").fields == []
    assert plan.conflicts == [
        "«orders»: в YAML элемент архитектуры другой («система») — в схеме оставляем как есть"
    ]
    assert plan.is_noop

    молчит = build_sync_plan(nodes, edges, _parse(RUN))
    assert молчит.is_noop and молчит.conflicts == []


def test_элемент_отказ_правила_по_живому_дереву_строкой():
    """YAML чист сам по себе, а живое дерево против: узел лежит в живом контейнере
    (Р5) или под ним живая база, которой нет в прогоне (Р6), — значение не ложится,
    причина — текстом отказа API."""
    nodes, edges = _seed(_parse(RUN))
    by_name = {n.name: n for n in nodes}
    by_name["Система"].element = "container"
    # orders — компонент живого контейнера: в зоне синка он только с галочкой.
    plan = build_sync_plan(nodes, edges, _parse(RUN_ЭЛЕМЕНТ), SyncPolicies(sync_components=True))
    assert _узел_плана(plan, "Система / orders").fields == []
    assert plan.conflicts == [
        "«orders»: элемент архитектуры из YAML не применён — объект «orders» лежит внутри "
        "контейнера «Система» и считается его компонентом. Элемент архитектуры задаётся у "
        "самого контейнера."
    ]

    nodes, edges = _seed(_parse(RUN))
    orders = next(n for n in nodes if n.name == "orders")
    nodes.append(Node(id=uuid.uuid4(), project_id=orders.project_id, name="orders-cache",
                      shape="database", parent_id=orders.id))
    plan = build_sync_plan(nodes, edges, _parse(RUN_ЭЛЕМЕНТ))
    assert _узел_плана(plan, "Система / orders").fields == []
    assert plan.conflicts == [
        "«orders»: элемент архитектуры из YAML не применён — внутри лежит база данных "
        "«orders-cache», она не может входить в состав контейнера. Вынесите её на уровень "
        "выше и повторите."
    ]


# ── База и брокер в живом контейнере: действующий родитель — родитель контейнера (Р6) ──

С_БАЗОЙ_В_КОНТЕЙНЕРЕ = RUN_ЭЛЕМЕНТ.replace(
    "      - name: orders\n        element: container\n",
    "      - name: orders\n        children:\n          - name: api\n"
    "          - name: orders-cache\n            shape: database\n",
)
С_КОМПОНЕНТАМИ = SyncPolicies(sync_components=True)


def _ids(nodes) -> dict[str, uuid.UUID]:
    return {n.name: n.id for n in nodes}


def test_база_в_живом_контейнере_создаётся_уровнем_выше():
    """Прогон кладёт базу в живой контейнер: создание — у родителя контейнера (живой
    parent_id старше пути), строка плана объясняет, почему не там, где в прогоне."""
    nodes, edges = _seed(_parse(RUN_ЭЛЕМЕНТ))
    plan = build_sync_plan(nodes, edges, _parse(С_БАЗОЙ_В_КОНТЕЙНЕРЕ), С_КОМПОНЕНТАМИ)

    кэш = _узел_плана(plan, "Система / orders / orders-cache")
    assert (кэш.action, кэш.parent_id, кэш.parent_path) == (
        "create", _ids(nodes)["Система"], None
    )
    api = _узел_плана(plan, "Система / orders / api")
    assert (api.action, api.parent_id, api.parent_path) == ("create", None, "Система / orders")
    assert plan.conflicts == [
        "«orders-cache»: база данных не может входить в состав контейнера «orders» — будет "
        "создана уровнем выше, в «Система»"
    ]


def test_брокер_корневого_контейнера_создаётся_на_верхнем_уровне():
    живой = "nodes:\n  - name: orders\n    element: container\n    children:\n      - name: api\n"
    прогон = (
        "nodes:\n  - name: orders\n    children:\n      - name: api\n"
        "      - name: Kafka\n        shape: broker\n"
    )
    nodes, edges = _seed(_parse(живой))
    # Без галочки брокер внутри живого контейнера вне зоны синка — как его компоненты.
    assert build_sync_plan(nodes, edges, _parse(прогон)).nodes[1:] == []
    plan = build_sync_plan(nodes, edges, _parse(прогон), С_КОМПОНЕНТАМИ)

    kafka = _узел_плана(plan, "orders / Kafka")
    assert (kafka.action, kafka.parent_id, kafka.parent_path) == ("create", None, None)
    assert plan.conflicts == [
        "«Kafka»: брокер не может входить в состав контейнера «orders» — будет создан на "
        "верхнем уровне"
    ]


def test_база_под_новым_компонентом_живого_контейнера_тоже_выносится():
    """Родитель базы в прогоне — новый компонент живого контейнера: он ляжет внутрь
    контейнера, значит и база оказалась бы в его составе."""
    прогон = RUN_ЭЛЕМЕНТ.replace(
        "      - name: orders\n        element: container\n",
        "      - name: orders\n        children:\n          - name: worker\n"
        "            children:\n              - name: orders-cache\n"
        "                shape: database\n",
    )
    nodes, edges = _seed(_parse(RUN_ЭЛЕМЕНТ))
    plan = build_sync_plan(nodes, edges, _parse(прогон), С_КОМПОНЕНТАМИ)

    кэш = _узел_плана(plan, "Система / orders / worker / orders-cache")
    assert (кэш.action, кэш.parent_id) == ("create", _ids(nodes)["Система"])
    assert _узел_плана(plan, "Система / orders / worker").parent_path == "Система / orders"


def test_база_под_живым_листом_без_элемента_не_выносится():
    """Лист без заданного элемента читается контейнером, но база внутри делает его
    системой — это законно, и синк кладёт её туда, куда прогон."""
    прогон = RUN.replace(
        "      - name: orders\n",
        "      - name: orders\n        children:\n          - name: orders-cache\n"
        "            shape: database\n",
    )
    nodes, edges = _seed(_parse(RUN))
    plan = build_sync_plan(nodes, edges, _parse(прогон), С_КОМПОНЕНТАМИ)

    кэш = _узел_плана(plan, "Система / orders / orders-cache")
    assert (кэш.action, кэш.parent_id, кэш.parent_path) == ("create", None, "Система / orders")
    assert plan.conflicts == []


def test_вынесенная_база_находится_уровнем_выше_фикспойнт():
    """Повторный прогон: база уже лежит у родителя контейнера — она и находится, план
    пуст по действиям, строка объясняет расхождение с прогоном."""
    nodes, edges = _seed(_parse(RUN_ЭЛЕМЕНТ))
    ids = _ids(nodes)
    for name, parent in (("api", "orders"), ("orders-cache", "Система")):
        nodes.append(Node(
            id=uuid.uuid4(), project_id=nodes[0].project_id, name=name,
            shape="database" if name == "orders-cache" else "service",
            status="existing", parent_id=ids[parent],
        ))
    plan = build_sync_plan(nodes, edges, _parse(С_БАЗОЙ_В_КОНТЕЙНЕРЕ), С_КОМПОНЕНТАМИ)

    assert plan.is_noop, plan.summary
    assert _узел_плана(plan, "Система / orders / orders-cache").node_id == _ids(nodes)["orders-cache"]
    assert plan.conflicts == [
        "«orders-cache»: база данных не может входить в состав контейнера «orders» — в "
        "схеме она лежит уровнем выше, в «Система»"
    ]


def test_база_уже_в_живом_контейнере_не_дублируется():
    """Создать базу под контейнером API не запрещает: если она уже лежит там, куда её
    кладёт прогон, — это она, без переноса и без второй копии уровнем выше."""
    nodes, edges = _seed(_parse(RUN_ЭЛЕМЕНТ))
    ids = _ids(nodes)
    for name, shape in (("api", "service"), ("orders-cache", "database")):
        nodes.append(Node(
            id=uuid.uuid4(), project_id=nodes[0].project_id, name=name, shape=shape,
            status="existing", parent_id=ids["orders"],
        ))
    plan = build_sync_plan(nodes, edges, _parse(С_БАЗОЙ_В_КОНТЕЙНЕРЕ), С_КОМПОНЕНТАМИ)

    assert plan.is_noop, plan.summary
    assert plan.conflicts == []


def test_зона_синка_по_глубине_прогона_прежняя():
    """База, которую прогон кладёт внутрь живого контейнера, без галочки вне синка (как
    и прежде, когда зона считалась по глубине), — ни действия, ни строки, хотя
    вынесенной она легла бы выше."""
    nodes, edges = _seed(_parse(RUN_ЭЛЕМЕНТ))
    plan = build_sync_plan(nodes, edges, _parse(С_БАЗОЙ_В_КОНТЕЙНЕРЕ))

    assert not any("orders-cache" in a.path for a in plan.nodes)
    assert plan.conflicts == []
    assert plan.is_noop


# ── Зона синка по элементу архитектуры, запасной путь — по глубине прогона (Ф6) ──

def _пути(plan) -> list[str]:
    return [a.path for a in plan.nodes]


def test_зона_контейнер_прогона_на_глубине_2_дети_вне_синка():
    """Контейнер в прогоне — его компоненты вне зоны, а сам он в ней (элемент
    доливается)."""
    nodes, edges = _seed(_parse(RUN))
    прогон = RUN_ЭЛЕМЕНТ.replace(
        "        element: container\n",
        "        element: container\n        children:\n          - name: api\n",
    )
    plan = build_sync_plan(nodes, edges, _parse(прогон))

    assert "Система / orders / api" not in _пути(plan)
    assert _узел_плана(plan, "Система / orders").fields == ["element"]
    assert _by_action(plan, "missing") == []


def test_зона_системы_вкладываются_на_любую_глубину():
    """Система на глубине 3 с контейнером на глубине 4 — в зоне; компонент контейнера
    на глубине 5 — нет. По глубине всё это было бы слоем компонентов."""
    nodes, edges = _seed(_parse(RUN))
    прогон = RUN.replace(
        "      - name: orders-db\n",
        "      - name: platform\n        children:\n          - name: shop\n"
        "            children:\n              - name: checkout\n"
        "                element: container\n                children:\n"
        "                  - name: handler\n"
        "      - name: orders-db\n",
    )
    plan = build_sync_plan(nodes, edges, _parse(прогон))

    assert _by_action(plan, "create") == [
        "Система / platform", "Система / platform / shop", "Система / platform / shop / checkout",
    ]
    assert not any(p.endswith("handler") for p in _пути(plan))


def _живой_контейнер_с_компонентами() -> tuple[list[Node], list[Edge]]:
    """Живой orders — контейнер с компонентами api и worker (прогон о них молчит)."""
    nodes, edges = _seed(_parse(RUN_ЭЛЕМЕНТ))
    orders = next(n for n in nodes if n.name == "orders")
    for name in ("api", "worker"):
        nodes.append(Node(id=uuid.uuid4(), project_id=orders.project_id, name=name,
                          shape="service", status="existing", parent_id=orders.id))
    return nodes, edges


def test_зона_компоненты_живого_контейнера_вне_синка_и_не_пропавшие():
    nodes, edges = _живой_контейнер_с_компонентами()
    прогон = RUN.replace(
        "      - name: orders\n",
        "      - name: orders\n        children:\n          - name: api\n"
        "          - name: scheduler\n",
    )
    plan = build_sync_plan(nodes, edges, _parse(прогон))

    # Прогон элемента не задаёт, но живой проект задал: зона по элементу.
    assert not any(p.startswith("Система / orders / ") for p in _пути(plan))
    assert _by_action(plan, "missing") == []
    assert plan.is_noop


def test_зона_с_галочкой_всё():
    nodes, edges = _живой_контейнер_с_компонентами()
    прогон = RUN_ЭЛЕМЕНТ.replace(
        "        element: container\n",
        "        element: container\n        children:\n          - name: api\n"
        "          - name: scheduler\n",
    )
    plan = build_sync_plan(nodes, edges, _parse(прогон), С_КОМПОНЕНТАМИ)

    assert _узел_плана(plan, "Система / orders / api").action == "unchanged"
    assert _by_action(plan, "create") == ["Система / orders / scheduler"]
    assert _by_action(plan, "missing") == ["Система / orders / worker"]


def test_зона_запасной_путь_по_глубине_без_элементов():
    """Элемент не задан нигде — зона прежняя, по глубине прогона: система на глубине 2
    отдаёт своих детей слою компонентов, живые дети не «пропавшие». Хоть один элемент с
    любой стороны — зона по элементу, и та же система вкладывается глубже."""
    живой = RUN.replace(
        "      - name: orders-db\n",
        "      - name: shop\n        children:\n          - name: cart\n"
        "      - name: orders-db\n",
    )
    прогон = живой.replace(
        "          - name: cart\n", "          - name: cart\n          - name: checkout\n"
    ).replace("          - name: cart\n", "")
    nodes, edges = _seed(_parse(живой))

    plan = build_sync_plan(nodes, edges, _parse(прогон))
    assert plan.is_noop and _by_action(plan, "missing") == []

    with_element = _parse(прогон.replace(
        "      - name: payments\n", "      - name: payments\n        element: container\n"
    ))
    plan = build_sync_plan(nodes, edges, with_element)
    assert _by_action(plan, "create") == ["Система / shop / checkout"]
    assert _by_action(plan, "missing") == ["Система / shop / cart"]
