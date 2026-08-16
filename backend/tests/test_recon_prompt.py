"""Тесты промпта РАЗВЕДКИ точек входа (app/recon_prompt.py, Ф0 docs/plan-recon.md).

Тесты структурные — по подстрокам-инвариантам: «качество» текста не проверить, но
можно закрепить ровно те правила, каждое из которых в замере полноты стоило реальных
пропусков (docs/qa-recon-completeness.md):

- «одно объявление = НЕСКОЛЬКО методов» — единственный класс, который не вылечил ни
  один заход скептика;
- «файл-СПИСОК маршрутов дочитать ДО КОНЦА» — прогон 1 оборвался на хвосте файла и
  потерял tornado с analytics;
- «маршруты объявлены и ниже по файлу, и в ДРУГИХ файлах» — прогону 2 стоило всего
  zilencer;
- «адрес воркера — имя ОЧЕРЕДИ, а не класса» — полнота очередей 14/14 дважды, а имена
  классов скачут 4/14 ↔ 14/14 (модель достраивает их по конвенции);
- «фоновая работа живёт и в конфигах развёртывания» — 14 puppet-кронов и демонов
  supervisor не вернул НИ ОДИН из пяти заходов.

⚠ Сентинелы промптов относительные и безусловных строк не сторожат: пропавшее правило
поймает только явная подстрока — потому здесь их так много.
"""

import uuid

import pytest
import yaml
from conftest import ensure_architect, ensure_project
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.auth import require_architect
from app.database import get_db
from app.deps import get_current_project
from app.main import app
from app.models.node import Node
from app.recon_prompt import RECON_FILE, build_recon_prompt
from app.routers.recon import recon_prompt
from app.skeptic_prompt import (
    BLOCK_A_END,
    BLOCK_A_START,
    BLOCK_B_END,
    BLOCK_B_START,
    BLOCK_C_END,
    BLOCK_C_START,
    RECON_RUN_1,
    RECON_RUN_2,
)

АДРЕС = "Zabbix 7 / zabbix-server"
# Порог V1 — маркер того, что перед нами именно промпт аудита (литерал, а не импорт
# константы: сверка константы с самой собой не поймала бы её правку).
ПОРОГ_V1 = (
    "Сомнение записывается ТОЛЬКО при конкретном доказательстве: процитированная "
    "строка кода, доказывающая обратное"
)
ВАРИАНТЫ = ("builder", "orchestrated", "skeptic")


def _есть(промпт: str, кусок: str) -> bool:
    """Подстрока с точностью до переносов: текст промпта переносится по ширине
    исходника и меняет разбивку от любой подстановки. Слова и их порядок тест держит,
    место переноса — нет."""
    return " ".join(кусок.split()) in " ".join(промпт.split())


def _образец(промпт: str) -> tuple[str, dict]:
    """Блок ```yaml из раздела формата: сырой текст и он же, разобранный YAML-парсером.

    Образец копируют ДОСЛОВНО — значит, он обязан быть валидным YAML, а не похожим на
    него текстом (та же гарантия, что у образца .mmd в docs_prompt и адреса в
    data_prompt)."""
    сырой = промпт.split("```yaml\n")[1].split("```")[0]
    return сырой, yaml.safe_load(сырой)


# ── Что нельзя делать: разведка не документация ───────────────────────────────


def test_запрет_рисовать_и_описывать():
    """⚠ Ловушка №7 плана: промпт доков запрещает sequenceDiagram, и разведка не смеет
    случайно разрешить рисовать что бы то ни было. Её выход — перечень, и только."""
    p = build_recon_prompt(АДРЕС)
    assert _есть(p, "Ничего не описывать, не рисовать схем, не объяснять, как это работает")
    assert _есть(p, "Только перечень")
    assert _есть(p, "Не пиши ничего, кроме указанных разделов: ни вступления, ни выводов, "
                    "ни описания архитектуры")
    assert "sequenceDiagram" not in p and "flowchart" not in p and "mermaid" not in p


def test_запрет_выдумывать_типовые_эндпоинты():
    """Единственная выдумка обоих прогонов — `POST /streams` «по аналогии» (в коде
    только GET). Класс назван в промпте поимённо, вместе с примерами."""
    p = build_recon_prompt(АДРЕС)
    assert _есть(p, "Ничего не выдумывай и не добавляй «для полноты» и «по аналогии»")
    assert _есть(p, "типовой эндпоинт, которого нет в коде (`GET /health`, `POST /login`), "
                    "— ошибка, а не находка")
    # Образец — из чужого репозитория: его строки не должны переехать в ответ.
    assert _есть(p, "Пример выше — из ЧУЖОГО репозитория")
    assert _есть(p, "если ты не увидел их в этом репозитории своими глазами")


def test_перечень_не_сокращать():
    p = build_recon_prompt(АДРЕС)
    assert _есть(p, "Не сокращай перечень многоточием, «и т.д.», «остальные аналогично»")
    assert _есть(p, "Не переписывай пути «как правильнее»")


# ── Правила, каждое из которых стоило замеру процентов ────────────────────────


def test_правило_несколько_методов_одного_объявления():
    """⚠ Класс, который НЕ вылечил ни один заход скептика (замер): строка в перечне
    есть, у неё просто не хватает второго метода — это не видно ни по счёту файлов,
    ни по списку источников. Лечится только правилом в промпте разведчика."""
    p = build_recon_prompt(АДРЕС)
    assert _есть(p, "Один маршрут часто объявляет НЕСКОЛЬКО МЕТОДОВ сразу")
    assert 'methods=["GET","POST"]' in p
    assert "route(...).get(...).post(...)" in p
    assert _есть(p, "Каждый метод — ОТДЕЛЬНАЯ строка перечня")


def test_правило_дочитать_файл_список_до_конца():
    """Прогон 1 оборвался на хвосте файла маршрутов — потерял tornado и analytics."""
    p = build_recon_prompt(АДРЕС)
    assert _есть(p, "Ищи ФАЙЛ, где маршруты СОБРАНЫ В СПИСОК")
    assert _есть(p, "найдя его, разбери ЕГО ЦЕЛИКОМ, от первой строки до последней")
    assert _есть(p, "Если файл маршрутов длинный, это нормально: выписывай всё")


def test_правило_маршруты_ниже_по_файлу_и_в_других_файлах():
    """Прогону 2 это стоило ВСЕГО zilencer: маршруты добавлялись в список ниже по
    файлу и в подключённых модулях."""
    p = build_recon_prompt(АДРЕС)
    assert _есть(p, "Маршруты бывают объявлены не только в главном файле")
    assert "include_router(...)" in p and "router.use(...)" in p
    assert "urls += [...]" in p and ".extend(...)" in p


def test_фоновая_работа_ищется_и_в_конфигах_развёртывания():
    """Вывод 4 замера: 14 puppet-кронов, крон email-mirror и демоны supervisor не
    вернул НИ ОДИН из пяти заходов — «воркер = маркер в коде» систематически неполно."""
    p = build_recon_prompt(АДРЕС)
    assert _есть(p, "конфиг celery/sidekiq/systemd/supervisor, файлы cron.d и crontab, "
                    "манифесты k8s CronJob")
    assert _есть(p, "Конфиги запуска: docker-compose*.yml, Procfile, supervisor/*.conf, "
                    "systemd-юниты, k8s-манифесты, puppet/ansible")
    assert _есть(p, "из них видны процессы, которых нет в коде явным списком")


def test_поиск_по_маркеру_и_сверка_счётом():
    p = build_recon_prompt(АДРЕС)
    assert _есть(p, "Работай ПОИСКОМ ПО КОДУ (grep/rg), а не чтением подряд")
    assert _есть(p, "ПОСЧИТАЙ вхождения маркера ДО того, как выписывать строки (`rg -c`)")
    assert _есть(p, "сверь с длиной своего перечня в конце")


def test_группа_сгенерированных_маршрутов_одной_строкой():
    """Число и справочник уезжают в `sources`: строка `operations` обязана остаться
    парой «метод + путь», иначе перечень нечем разобрать."""
    p = build_recon_prompt(АДРЕС)
    assert _есть(p, "Маршруты бывают СГЕНЕРИРОВАНЫ циклом из справочника")
    assert _есть(p, "Такую группу выпиши ОДНОЙ строкой `operations` — путь-шаблон дословно "
                    "как в коде")
    assert _есть(p, "а сколько их и из какого справочника — отдельной строкой в `sources`")


def test_порядок_обследования_из_пяти_шагов():
    """Процедура обхода — замеренный артефакт целиком, включая запрет читать лишнее
    (без него слабая модель уходит в node_modules и тесты)."""
    p = build_recon_prompt(АДРЕС)
    шаги = p.split("## Порядок обследования")[1].split("## Как искать")[0]
    for n in range(1, 6):
        assert f"\n{n}. " in шаги, n
    assert _есть(шаги, "Только после шагов 1–4 — точечные заглядывания в код")
    assert _есть(p, "ЗАПРЕЩЕНО: читать lock-файлы, node_modules/, vendor/, dist/, тесты, "
                    "миграции, локализацию")


# ── Формат результата (Р1: YAML, один файл, узнаваемый корень) ────────────────


def test_образец_это_валидный_YAML_с_корнем_archmap_recon():
    сырой, разобранный = _образец(build_recon_prompt(АДРЕС))
    assert сырой.startswith("# archmap-recon\n")
    assert _есть(build_recon_prompt(АДРЕС), "Первая строка — ровно «# archmap-recon», "
                                            "именно с решёткой")
    assert set(разобранный) == {"node", "operations", "workers", "sources", "doubts"}


def test_адрес_узла_подставлен_и_в_образец_и_в_правило():
    """Адрес узла — единственный параметр промпта (Р3: ни среза схемы, ни прошлого
    перечня). Он обязан стоять В ОБРАЗЦЕ, иначе слабая модель его выдумывает —
    ровно та находка полевого QA, что вылечена в промпте структуры БД."""
    p = build_recon_prompt("Ярмарка / Ядро / orders")
    _, разобранный = _образец(p)
    assert разобранный["node"] == "Ярмарка / Ядро / orders"
    assert _есть(p, "Пиши его ДОСЛОВНО: «Ярмарка / Ядро / orders»")
    assert _есть(p, "хвост-пояснение после него станет частью адреса")
    # Чужого адреса в тексте не осталось — выдумывать нечего.
    assert "Zulip" not in p


def test_операции_парой_метод_путь_дословно_как_в_коде():
    p = build_recon_prompt(АДРЕС)
    _, разобранный = _образец(p)
    assert разобранный["operations"] == ["GET /messages", "POST /messages",
                                         "PATCH /messages/{message_id}"]
    assert _есть(p, "Метод заглавными")
    assert _есть(p, "Путь — ДОСЛОВНО как в коде, с ведущим слэшем")
    assert _есть(p, "параметры пути оставляй как в исходнике (`<int:user_id>`, `{userId}`, "
                    "`:id` — не переписывай в свою нотацию)")
    assert _есть(p, "Общий префикс монтирования не дописывай")


def test_воркер_адресуется_именем_очереди_а_не_класса():
    """⚠ Имя обработчика — НЕДОВЕРЕННОЕ поле: в слабом прогоне десять имён из
    четырнадцати синтезированы по конвенции («embed_links» → «EmbedLinksWorker» вместо
    реального FetchLinksEmbedData). В данные его не пускаем ни строкой образца, ни
    правилом формата."""
    p = build_recon_prompt(АДРЕС)
    _, разобранный = _образец(p)
    # В образце — голые имена очередей, без «— Обработчик» после тире.
    assert разобранный["workers"] == ["email_senders", "missedmessage_emails"]
    assert all(" — " not in w for w in разобранный["workers"])
    assert _есть(p, "ИМЯ ОЧЕРЕДИ, задачи, джоба или крона — то, чем воркер адресуется")
    assert _есть(p, "Имя класса или функции-обработчика в этот раздел НЕ пиши")
    assert _есть(p, "Хочешь назвать обработчика — его место в `sources`")
    # И в перечне классов точек входа воркер тоже без обработчика.
    assert _есть(p, "Формат строки — имя очереди, задачи, джоба или крона")


def test_источники_и_сомнения_обязательны():
    """Оба раздела приёмник не применяет, но в промпте они обязательны: `sources` —
    самосверка агента, `doubts` — «лучше строка в сомнениях, чем молчание»."""
    p = build_recon_prompt(АДРЕС)
    _, разобранный = _образец(p)
    assert разобранный["sources"] and разобранный["doubts"]
    assert _есть(p, "число вхождений должно объяснять длину перечня. Раздел обязателен")
    assert _есть(p, "Лучше строка в «сомнениях», чем молчание. Раздел обязателен; "
                    "сомнений нет — оставь `doubts: []`")


# ── Путь результата (Р2: корень репозитория, параметр генератора) ─────────────


def test_по_умолчанию_перечень_кладётся_в_корень():
    """⚠ Не в `archmap-docs/` и не в `archmap-orch/`: обе папки сносятся соседними
    BYOA-потоками и оркестратором на шаге 1 — перечень там не жилец."""
    p = build_recon_prompt(АДРЕС)
    assert RECON_FILE == "archmap-recon.yaml"
    assert _есть(p, f"запиши перечень в файл `{RECON_FILE}` (путь от корня репозитория)")
    assert "archmap-docs/" not in p
    assert "archmap-orch/" not in p


def test_путь_результата_параметризуется_целиком():
    """Оркестраторная петля гоняет два прогона в РАЗНЫЕ файлы. Остаток дефолтного пути
    в тексте увёл бы оба прогона в один файл — второй затёр бы первый молча."""
    p = build_recon_prompt(АДРЕС, result_path="archmap-orch/recon-2.yaml")
    assert _есть(p, "запиши перечень в файл `archmap-orch/recon-2.yaml`")
    assert RECON_FILE not in p
    # Остальное от пути не зависит: правила и образец те же.
    дефолтный = build_recon_prompt(АДРЕС)
    assert p.split("## Формат ответа")[0] == дефолтный.split("## Формат ответа")[0]


# ── Ручка GET /recon/prompt ───────────────────────────────────────────────────


def _схема(db):
    """Проект с контейнером и сервисом внутри: адрес узла — ПОЛНЫЙ путь, и именно его
    промпт обязан донести до агента."""
    p = ensure_project(db)
    система = Node(id=uuid.uuid4(), name="Zabbix 7", shape="service", project_id=p.id)
    db.add(система)
    db.flush()
    сервис = Node(
        id=uuid.uuid4(), name="zabbix-server", shape="service", project_id=p.id,
        parent_id=система.id,
    )
    db.add(сервис)
    db.flush()
    return p, сервис


@pytest.mark.parametrize("variant", ВАРИАНТЫ)
def test_ручка_все_варианты_отдают_текст(db, variant):
    p, сервис = _схема(db)
    out = recon_prompt(
        node_id=сервис.id, variant=variant, db=db, project=p, _=ensure_architect(db)
    )
    assert out.prompt.strip()


def test_ручка_дефолт_байт_в_байт_и_с_полным_путём_узла(db):
    """Адрес — ПОЛНЫЙ путь узла, тот же, что понимает резолвер дозаливки. И дефолт
    равен прямому вызову генератора: на нём будут сидеть MCP-тулза и окно фронта."""
    p, сервис = _схема(db)
    прямой = build_recon_prompt(АДРЕС)

    без = recon_prompt(node_id=сервис.id, db=db, project=p, _=ensure_architect(db))
    явный = recon_prompt(
        node_id=сервис.id, variant="builder", db=db, project=p, _=ensure_architect(db)
    )
    assert без.prompt == прямой
    assert явный.prompt == прямой
    assert АДРЕС in без.prompt


def test_ручка_404_если_узла_нет_в_проекте(db):
    """⚠ Разведка без адреса бессмысленна: чужой или удалённый узел — 404, а не
    молчаливый промпт с выдуманным адресом."""
    p, _сервис = _схема(db)
    with pytest.raises(HTTPException) as ошибка:
        recon_prompt(node_id=uuid.uuid4(), db=db, project=p, _=ensure_architect(db))
    assert ошибка.value.status_code == 404


def test_ручка_обёртка_несёт_два_прогона_в_разные_файлы(db):
    """Оркестраторный вариант: блоки А и Б — промпты разведчиков с РАЗНЫМИ файлами
    результата, блок В — аудит. Один файл на два прогона = потерянный второй прогон."""
    p, сервис = _схема(db)
    out = recon_prompt(
        node_id=сервис.id, variant="orchestrated", db=db, project=p, _=ensure_architect(db)
    )

    блок_а = out.prompt.split(BLOCK_A_START)[1].split(BLOCK_A_END)[0]
    блок_б = out.prompt.split(BLOCK_B_START)[1].split(BLOCK_B_END)[0]
    блок_в = out.prompt.split(BLOCK_C_START)[1].split(BLOCK_C_END)[0]

    assert блок_а == f"\n{build_recon_prompt(АДРЕС, result_path=RECON_RUN_1)}\n"
    assert блок_б == f"\n{build_recon_prompt(АДРЕС, result_path=RECON_RUN_2)}\n"
    assert ПОРОГ_V1 in блок_в
    # Адрес узла доехал до ОБОИХ разведчиков — иначе объединять будет нечего.
    assert АДРЕС in блок_а and АДРЕС in блок_б


def test_ручка_скептик_это_аудит_а_не_разведка(db):
    p, сервис = _схема(db)
    out = recon_prompt(
        node_id=сервис.id, variant="skeptic", db=db, project=p, _=ensure_architect(db)
    )
    assert ПОРОГ_V1 in out.prompt
    assert "archmap-skeptic-report.md" in out.prompt
    # Чек-лист именно разведки, и строительного промпта здесь нет.
    assert "КАЖДЫЙ источник из раздела `sources`" in out.prompt
    assert "## Порядок обследования" not in out.prompt


def test_три_варианта_различаются(db):
    p, сервис = _схема(db)
    тексты = {
        v: recon_prompt(
            node_id=сервис.id, variant=v, db=db, project=p, _=ensure_architect(db)
        ).prompt
        for v in ВАРИАНТЫ
    }
    assert len(set(тексты.values())) == 3


@pytest.fixture()
def клиент(db):
    """HTTP-клиент с подменёнными зависимостями: обязательность query-параметра и
    валидацию его значения проверяет FastAPI — видно это только настоящим запросом."""
    p, сервис = _схема(db)
    user = ensure_architect(db)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_current_project] = lambda: p
    app.dependency_overrides[require_architect] = lambda: user
    try:
        yield TestClient(app), сервис
    finally:
        app.dependency_overrides.clear()


def test_ручка_требует_node_id_и_валидирует_variant(клиент):
    c, сервис = клиент
    # ⚠ node_id обязателен (Р4): без него — 422, а не промпт «в никуда».
    assert c.get("/api/v1/recon/prompt").status_code == 422
    assert c.get(f"/api/v1/recon/prompt?node_id={сервис.id}&variant=разведка-лайт").status_code == 422
    # А валидные значения проходят — 422 не от чего-то другого.
    for v in ВАРИАНТЫ:
        ok = c.get(f"/api/v1/recon/prompt?node_id={сервис.id}&variant={v}")
        assert ok.status_code == 200, (v, ok.text)
        assert ok.json()["prompt"].strip()
    # Узел не из этого проекта — 404 и через HTTP.
    assert c.get(f"/api/v1/recon/prompt?node_id={uuid.uuid4()}").status_code == 404
