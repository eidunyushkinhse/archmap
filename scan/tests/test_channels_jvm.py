"""Топики Kafka в коде Java и Kotlin (ТЗ §15 п. 17 В1): подписки списками и шаблонами,
@KafkaListener, ProducerRecord и шаблон отправки Spring; брокер по клиенту Kafka."""

from __future__ import annotations

import random
from pathlib import Path

from archmap_scan import jvm, registry, stats, texts
from archmap_scan.parsers import kafkajvm
from tests.helpers import FIXTURES, files_of, model_of, tree

ROOT = FIXTURES / "kafka-jvm"
ORD = "orders/src/main/java/shop/Orders.java"
FR = "fraud/src/main/kotlin/shop/Fraud.kt"
KAFKA_POM = (
    "<project><artifactId>x</artifactId><dependencies><dependency>"
    "<artifactId>kafka-clients</artifactId></dependency></dependencies></project>\n"
)
PLAIN_POM = "<project><artifactId>y</artifactId></project>\n"


def _channels(root: Path) -> list[tuple[str, str, str, str]]:
    ctx, files = files_of(root)
    return sorted(
        (str(c.loc), c.name, c.direction or "", c.client) for c in kafkajvm.parse(files, ctx).channels
    )


def test_fixture_channels() -> None:
    """Списки List.of, Arrays.asList, Collections.singletonList (с константой класса),
    Kotlin listOf и setOf в блоке apply, @KafkaListener строкой и массивом, ProducerRecord
    с параметрами типа и без, kafkaTemplate.send; переменная файла с дефолтом окружения
    (Optional Java, элвис Kotlin) даёт имя дефолтом."""
    assert _channels(ROOT) == [
        (f"{FR}:10", "alerts", "consume", "Kafka"),
        (f"{FR}:11", "verdicts", "publish", "Kafka"),
        (f"{FR}:16", "kt-events", "consume", "Kafka"),
        (f"{FR}:8", "orders", "consume", "Kafka"),
        (f"{ORD}:10", "payments", "consume", "Kafka"),
        (f"{ORD}:11", "credits", "consume", "Kafka"),
        (f"{ORD}:11", "invoices", "consume", "Kafka"),
        (f"{ORD}:12", "refunds", "consume", "Kafka"),
        (f"{ORD}:21", "orders", "publish", "Kafka"),
        (f"{ORD}:22", "audit", "publish", "Kafka"),
        (f"{ORD}:23", "shipments", "publish", "Kafka"),
        (f"{ORD}:27", "returns", "consume", "Kafka"),
        (f"{ORD}:30", "alpha", "consume", "Kafka"),
        (f"{ORD}:30", "beta", "consume", "Kafka"),
    ]


def test_fixture_links() -> None:
    """Каналы у брокера kafka из compose; потребление — связь брокер → контейнер,
    публикация — контейнер → брокер, с именем канала. Пакет без Kafka (plain) и каталог
    тестов не читаются."""
    model = model_of(ROOT)
    assert sorted(model.channels["kafka"]) == [
        "alerts", "alpha", "audit", "beta", "credits", "invoices", "kt-events", "orders",
        "payments", "refunds", "returns", "shipments", "verdicts",
    ]
    links = sorted((lk.src.name, lk.dst.name, lk.channel or "") for lk in model.links)
    assert ("kafka", "fraud", "orders") in links
    assert ("orders", "kafka", "orders") in links
    assert ("fraud", "kafka", "verdicts") in links
    assert not any("plain" in (src, dst) for src, dst, _ch in links)
    assert [c.channel for c in model.consumers["fraud"]] == ["alerts", "kt-events", "orders"]


def test_fixture_hints() -> None:
    """Шаблон Pattern.compile, вызов и шаблон Kotlin с «$» дают подсказку о динамическом
    имени; обработчики реактивных потоков (лямбда, ссылка на метод), комментарии и строки
    подсказок не дают."""
    ctx, files = files_of(ROOT)
    hints = sorted(
        (h.data["source"], h.data["name"], h.data["reason"]) for h in kafkajvm.parse(files, ctx).hints
    )
    assert hints == [
        (f"{FR}:12", '"$prefix-out"', texts.REASON_DYNAMIC_CHANNEL),
        (f"{ORD}:13", 'Pattern.compile("orders-.*")', texts.REASON_DYNAMIC_CHANNEL),
        (f"{ORD}:24", 'topicFor("x")', texts.REASON_DYNAMIC_CHANNEL),
    ]


def test_unsupported_by_package() -> None:
    """Язык уходит из непрочитанных каналов только у пакета с Kafka: Kotlin (fraud) не
    назван, Java назван по пакету plain без Kafka."""
    ctx, files = files_of(ROOT)
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    channels = stats.code_unsupported(found).get("channels", [])
    assert "Kotlin" not in channels
    assert "Java" in channels


def test_only_kafka_package(tmp_path: Path) -> None:
    """Все пакеты Java с Kafka: Java в непрочитанных каналах не назван; маршруты и
    расписания по-прежнему по своим правилам."""
    tree(tmp_path, {
        "a/pom.xml": KAFKA_POM,
        "a/src/main/java/A.java": 'class A { void f() { c.subscribe(List.of("t")); } }\n',
    })
    ctx, files = files_of(tmp_path)
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    assert "Java" not in stats.code_unsupported(found).get("channels", [])
    assert [(c.name, c.direction) for c in found.channels] == [("t", "consume")]


def test_other_brokers_named(tmp_path: Path) -> None:
    """Пакет с Kafka и клиентом RabbitMQ: Java не назван (Kafka читается), а RabbitMQ назван
    «Java: RabbitMQ», его каналы не читаются."""
    tree(tmp_path, {
        "a/pom.xml": KAFKA_POM.replace(
            "</dependencies>", "<dependency><artifactId>spring-rabbit</artifactId></dependency>"
            "</dependencies>",
        ),
        "a/src/main/java/A.java": 'class A { void f() { c.subscribe(List.of("t")); } }\n',
    })
    ctx, files = files_of(tmp_path)
    found, errors = registry.collect(files, ctx)
    assert errors == {}
    assert stats.code_unsupported(found).get("channels", []) == ["Java: RabbitMQ"]


def test_without_kafka_not_read(tmp_path: Path) -> None:
    """Пакет Java без kafka-clients и spring-kafka не читается: subscribe там чужой."""
    tree(tmp_path, {
        "a/pom.xml": PLAIN_POM,
        "a/src/main/java/A.java": 'class A { void f() { c.subscribe(List.of("t")); } }\n',
    })
    ctx, files = files_of(tmp_path)
    found = kafkajvm.parse(files, ctx)
    assert found.channels == [] and found.applied == set()
    collected, _errors = registry.collect(files, ctx)
    assert "Java" in stats.code_unsupported(collected).get("channels", [])


def test_names(tmp_path: Path) -> None:
    """Константа другого класса Java раскрывается (clike), переменная с разными дефолтами
    неоднозначна (подсказка), Kotlin const val не раскрывается (подсказка), spring-kafka по
    строке Gradle тоже стек."""
    tree(tmp_path, {
        "a/pom.xml": KAFKA_POM,
        "a/src/main/java/Topics.java": 'class Topics { static final String ORDERS = "orders"; }\n',
        "a/src/main/java/A.java": (
            "class A {\n"
            '  void f() { p.send(new ProducerRecord<>(Topics.ORDERS, "v")); }\n'
            '  String t = Optional.ofNullable(System.getenv("A")).orElse("x");\n'
            '  String t = Optional.ofNullable(System.getenv("B")).orElse("y");\n'
            "  void g() { c.subscribe(List.of(t)); }\n"
            "}\n"
        ),
        "k/build.gradle.kts": (
            'plugins { kotlin("jvm") }\n'
            'dependencies { implementation("org.springframework.kafka:spring-kafka:3.2.0") }\n'
        ),
        "k/src/main/kotlin/K.kt": 'const val T = "kt"\nfun f() { template.send(T, "v") }\n',
    })
    ctx, files = files_of(tmp_path)
    found = kafkajvm.parse(files, ctx)
    assert [(c.name, str(c.loc)) for c in found.channels] == [
        ("orders", "a/src/main/java/A.java:2"),
    ]
    assert sorted((h.data["name"], h.data["source"]) for h in found.hints) == [
        ("T", "k/src/main/kotlin/K.kt:2"),
        ("t", "a/src/main/java/A.java:5"),
    ]


def test_budget(tmp_path: Path) -> None:
    """Больше 2000 топиков в файле (враждебный вход): файл непрочитан, записей из него нет."""
    many = "".join(f'  void f{i}() {{ c.subscribe(List.of("t{i}")); }}\n' for i in range(2001))
    tree(tmp_path, {
        "a/pom.xml": KAFKA_POM,
        "a/src/main/java/A.java": "class A {\n" + many + "}\n",
        "a/src/main/java/B.java": 'class B { void f() { c.subscribe(List.of("b")); } }\n',
    })
    ctx, files = files_of(tmp_path)
    found = kafkajvm.parse(files, ctx)
    assert [c.name for c in found.channels] == ["b"]
    assert "a/src/main/java/A.java" in files.too_large


def test_trim_same_as_strip() -> None:
    """Обрезка пробелов аргумента без копии всего отрезка (вложенные вызовы В1) даёт те же
    границы, что strip: короткие и длинные пробелы с обоих краёв, пустые и сплошь пробельные
    отрезки."""
    rnd = random.Random(5)
    for _ in range(300):
        parts = [rnd.choice([" ", "\t", "\n", "\r", "a", "(", ""]) * rnd.choice([0, 1, 3, 5000])
                 for _ in range(4)]
        mask = "".join(parts)
        lo = rnd.randrange(len(mask) + 1)
        hi = rnd.randrange(lo, len(mask) + 1)
        seg = mask[lo:hi]
        stripped = seg.strip(" \t\r\n")
        want = (lo, lo) if not stripped else (
            lo + len(seg) - len(seg.lstrip(" \t\r\n")), hi - (len(seg) - len(seg.rstrip(" \t\r\n"))),
        )
        assert jvm._trim(mask, lo, hi) == want
