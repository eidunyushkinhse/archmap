"""Манифесты Kubernetes и чарты Helm."""

from __future__ import annotations

import time
from pathlib import Path

from archmap_scan import texts
from archmap_scan.parsers import helm, k8s
from tests.helpers import FIXTURES, files_of, model_of, time_limit, tree


def test_k8s_units() -> None:
    ctx, files = files_of(FIXTURES / "k8s")
    found = k8s.parse(files, ctx)
    units = {u.name: u for u in found.units}
    # collector: «{{PROJECT_ID}}» в данных ConfigMap не Helm; templated.yaml с
    # «{{ .Values.image }}» по-прежнему шаблон чарта и в объекты не идёт.
    assert set(units) == {"orders", "orders-db", "cleanup", "events", "collector"}
    assert units["collector"].image == "otel/opentelemetry-collector-contrib:0.100.0"
    assert found.hints == []
    orders = units["orders"]
    assert orders.image == "ghcr.io/org/orders:1.4.2"
    assert orders.command == "uvicorn orders.main:app"
    assert orders.host == "orders-api"
    env = {e.name: e for e in orders.env}
    assert set(env) == {"DATABASE_URL", "API_TOKEN", "SELF", "KAFKA_BOOTSTRAP", "LOG_LEVEL"}
    assert env["API_TOKEN"].value is None and env["SELF"].dynamic
    assert str(env["KAFKA_BOOTSTRAP"].loc) == "base/orders.yaml:41"
    assert units["orders-db"].host == "orders-db"
    assert units["cleanup"].schedule == "0 3 * * *" and units["cleanup"].role == "планировщик"


def test_k8s_model() -> None:
    model = model_of(FIXTURES / "k8s")
    kinds = {o.name: (o.shape, o.technology, o.host) for o in model.objects}
    assert kinds == {
        "orders": ("service", "orders", "orders-api"),
        "cleanup": ("service", "orders", None),
        "orders-db": ("database", "PostgreSQL", "orders-db"),
        "events": ("broker", "Kafka", None),
        "collector": ("service", "opentelemetry-collector-contrib", None),
    }
    links = {(lk.src.name, lk.dst.name) for lk in model.links}
    # events без Service: имени зависимости нет, адрес events:9092 ни к чему не ведёт.
    assert links == {("orders", "orders-db")}
    assert [s.schedule for s in model.schedules["cleanup"]] == ["0 3 * * *"]


def test_k8s_placeholder_and_helm_marks(tmp_path: Path) -> None:
    """Подстановка вне блочной строки ломает YAML: файл в hints.unparsed, а не молча
    пропущен. Разметка Helm («{{-», «{{ include», «{{ .Release») роняет файл без подсказки."""
    head = "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n"
    root = tree(tmp_path, {
        "k/bad.yaml": head + "  name: {{NAME}}\n  labels: {{LABELS}}\n",
        "k/dash.yaml": head + "  name: a\n{{- if .Values.x }}\n",
        "k/include.yaml": head + "  name: {{ include \"x\" . }}\n",
        "k/release.yaml": head + "  name: {{.Release.Name}}\n",
    })
    ctx, files = files_of(root)
    found = k8s.parse(files, ctx)
    assert found.units == []
    assert [(h.section, h.data["name"], h.data["reason"]) for h in found.hints] == [
        ("unparsed", "k/bad.yaml", texts.REASON_BAD_YAML),
    ]


def test_helm_units_and_templates() -> None:
    ctx, files = files_of(FIXTURES / "helm")
    found = helm.parse(files, ctx)
    units = {u.name: u.image for u in found.units}
    assert units == {
        "postgresql": "postgresql",
        "shop": "ghcr.io/org/shop",
        "worker": "ghcr.io/org/shop-worker",
        "envoy": "envoyproxy/envoy:v1.30",
    }
    assert found.unsupported == {"containers": ["Helm templates"]}
    assert [h.data["name"] for h in found.hints] == ["cache"]
    model = model_of(FIXTURES / "helm")
    assert {o.name: o.shape for o in model.objects}["postgresql"] == "database"


def test_helm_mark_regex_on_hostile_text() -> None:
    """Признак Helm на враждебном тексте: длинные пробелы после «{{» и сплошные «{{»."""
    for text in ("{{" + " \t" * 1_000_000, "{{ " * 700_000, "{" * 2_000_000, "{{ Values" * 250_000):
        started = time.perf_counter()
        assert k8s._HELM.search(text) is None
        assert time.perf_counter() - started < time_limit()


def test_helm_rendered_output_not_read() -> None:
    """Отрендеренный шаблон Helm не разбирается (ТЗ §15 п. 12 С10). Airflow:
    chart/kustomize-overlays/kerberos/kdc-deployment.yaml и keytab-bootstrap-job.yaml с
    именами RELEASE-NAME-* давали объекты «RELEASE-NAME-kerberos-kdc» и
    «RELEASE-NAME-keytab-bootstrap». Признак — RELEASE-NAME в metadata.name или в образе.
    Ловушка: обычный оверлей kustomize с настоящими именами читается, метка с тем же словом
    признаком не считается."""
    ctx, files = files_of(FIXTURES / "k8s-rendered")
    found = k8s.parse(files, ctx)
    assert [u.name for u in found.units] == ["worker"]
    assert sorted(str(h.data["name"]) for h in found.hints if h.section == "unparsed") == [
        "chart/kustomize-overlays/kerberos/kdc-deployment.yaml",
        "chart/kustomize-overlays/kerberos/keytab-bootstrap-job.yaml",
    ]
    assert {h.data["reason"] for h in found.hints} == {texts.REASON_HELM_RENDERED}
    assert found.notes == {"containers": [texts.NOTE_HELM_RENDERED]}


def test_network_policy_links() -> None:
    """Связи NetworkPolicy (ТЗ §15 п. 14 Ж1). Найдено в Argo CD:
    manifests/base/redis/argocd-redis-network-policy.yaml:19 — ingress.from[].podSelector
    (app.kubernetes.io/name: argocd-server) к поду spec.podSelector argocd-redis; связей между
    компонентами в env манифестов нет. Ловушки: пиры namespaceSelector и ipBlock связей не
    дают; podSelector {} у пира и у политики (все поды) — подсказки; метка без пода —
    подсказка; пара api → redis из env и из двух политик — одна связь с тремя основаниями."""
    root = FIXTURES / "k8s-network-policy"
    ctx, files = files_of(root)
    found = k8s.parse(files, ctx)
    assert [(lk.src, lk.dst, str(lk.loc)) for lk in found.links] == [
        ("web", "redis", "deploy/policies.yaml:13"),
        ("api", "redis", "deploy/policies.yaml:16"),
        ("api", "redis", "deploy/policies.yaml:36"),
    ]
    assert sorted((h.data["name"], h.data["reason"], h.data["source"]) for h in found.hints) == [
        ("all-pods", texts.REASON_POLICY_ALL_PODS, "deploy/open.yaml:4"),
        ("app.kubernetes.io/name=worker→redis", texts.REASON_POD_NOT_FOUND,
         "deploy/policies.yaml:19"),
        ("все поды→api", texts.REASON_POLICY_ALL_PODS, "deploy/policies.yaml:39"),
    ]
    model = model_of(root)
    links = {(lk.src.name, lk.dst.name): lk for lk in model.links}
    assert sorted(links) == [("api", "redis"), ("web", "redis")]
    assert sorted(str(loc) for loc in links[("api", "redis")].locs) == [
        "deploy/apps.yaml:29", "deploy/policies.yaml:16", "deploy/policies.yaml:36",
    ]
    web = links[("web", "redis")]
    assert (web.technology, web.channel, web.sync) == ("Redis", None, None)


def test_network_policy_shared_label_is_fast(tmp_path: Path) -> None:
    """Враждебный вход: тысячи нагрузок с одной меткой и тысячи пиров политики. Пары не
    размножаются (у пира больше 50 пар — подсказка), разбор укладывается в предел."""
    pod = (
        "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: w{i}\nspec:\n  template:\n"
        "    metadata:\n      labels:\n        app: x\n"
    )
    peers = "".join("    - podSelector:\n        matchLabels:\n          app: x\n" for _ in range(2000))
    policy = (
        "apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: p\nspec:\n"
        "  podSelector:\n    matchLabels:\n      app: x\n  ingress:\n  - from:\n" + peers
    )
    root = tree(tmp_path, {
        "k8s/pods.yaml": "---\n".join(pod.format(i=i) for i in range(2000)),
        "k8s/policy.yaml": policy,
    })
    ctx, files = files_of(root)
    started = time.perf_counter()
    found = k8s.parse(files, ctx)
    assert time.perf_counter() - started < 10 * time_limit()
    assert found.links == [] and len(found.hints) == 2000
