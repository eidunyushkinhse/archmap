"""Словари предметной области — единственный источник Literal-ов и их рантайм-наборов.

Раньше одни и те же наборы объявлялись по два-три раза (аудит Q-5): форма узла — в
schemas/node и ещё раз в schemas/process, режим пометки — в data_refs и schemas/
data_refs, кортежи форм и видов — руками в import_yaml и mmd_header. Здесь — один раз;
схемы API, модели и доменные модули импортируют отсюда, наборы для проверок берутся
через get_args. Модуль чистый: без SQLAlchemy и Pydantic — его тянут и схемы, которые
импортирует MCP-сервер для сверки контракта.
"""

from typing import Literal, get_args

# C4-формы узла. Фронтовый NodeShape генерируется из контракта (openapi-typescript).
NodeShape = Literal["service", "database", "broker", "person"]
NODE_SHAPES: tuple[NodeShape, ...] = get_args(NodeShape)

# Статус жизненного цикла узла.
NodeStatus = Literal["existing", "planned", "deprecated"]
NODE_STATUSES: tuple[NodeStatus, ...] = get_args(NodeStatus)

# Статус СТРАНИЦЫ объекта, не жизненный цикл (docs/tasks/page-status.md): «в работе» —
# документация ещё правится, «согласовано» — проверена редактором проекта. У листа
# хранится в nodes.approval, у контейнера вычисляется по детям (app/approval.py).
NodeApproval = Literal["in_progress", "approved"]
NODE_APPROVALS: tuple[NodeApproval, ...] = get_args(NodeApproval)

# Элемент архитектуры узла с детьми (docs/plan-c4-elements.md, раздел 0а): хранимое значение
# (nodes.element) — system | container | None, где None («не сказано») читается как система,
# как у всех узлов с детьми до эпика. Действующий элемент (app/element.py) добавляет
# component — всё, что лежит внутри контейнера.
NodeElement = Literal["system", "container"]
NODE_ELEMENTS: tuple[NodeElement, ...] = get_args(NodeElement)
NodeElementEffective = Literal["system", "container", "component"]
# Последствия смены элемента или переноса узла для размещения (app/element_change, Р18):
# система ↔ контейнер у узла с детьми, вход в контейнер (переносимое становится его
# частью) и выход из него; none — площадки никуда не переезжают.
ElementChangeKind = Literal[
    "none", "system_to_container", "container_to_system", "join_container", "leave_container"
]

# Вид версии документации объекта (docs/tasks/doc-versions.md): manual — ручная
# фиксация редактором с его комментарием; pre_restore — автоматическая «Перед откатом
# к vN», чтобы откат не терял незафиксированное; restore — автоматическая «Откат к vN»,
# запись истории вперёд (номер источника — в restored_from).
VersionKind = Literal["manual", "pre_restore", "restore"]
VERSION_KINDS: tuple[VersionKind, ...] = get_args(VersionKind)

# Категория элемента дельты версий (app/versions_diff.py), в порядке показа: свойства
# объекта, связи, схема логики, спека OpenAPI, структура БД, каналы брокера,
# конфигурация, размещение на площадках, статус страницы, процесс.
VersionCategory = Literal[
    "props",
    "edges",
    "doc",
    "spec",
    "db",
    "channels",
    "config",
    "placement",
    "approval",
    "process",
]
VERSION_CATEGORIES: tuple[VersionCategory, ...] = get_args(VersionCategory)

# Что случилось с элементом между двумя версиями. Переименование — changed: элементы
# сопоставляются по id, а не по имени.
VersionItemStatus = Literal["added", "removed", "changed"]

# Пометка строки в представлении дельты: пусто — без изменений (контекст), add — новая,
# del — удалённая, mod — изменённая (и заголовок куска построчной дельты), move —
# только переставлена (шаг процесса, колонка таблицы, поле сообщения).
DiffMark = Literal["", "add", "del", "mod", "move"]

# Вид схемы логики: обе — точки входа (вид «обзор» удалён 2026-08-18). Поле operation
# заполняется только у операций СОБСТВЕННОГО API узла.
NodeDocKind = Literal["operation", "worker"]
NODE_DOC_KINDS: tuple[NodeDocKind, ...] = get_args(NodeDocKind)

# Вид площадки развёртывания (docs/tasks/deployment-view.md): облако или управляемый
# сервис, кластер Kubernetes, виртуальная машина, физический сервер, прочее (ЦОД,
# стойка). Конкретика («Yandex Cloud», «k3s 1.30») — технологией площадки свободным
# текстом, как у узла: перечисление поставщиков здесь врало бы про их разнообразие.
SiteKind = Literal["cloud", "kubernetes", "vm", "physical", "other"]
SITE_KINDS: tuple[SiteKind, ...] = get_args(SiteKind)

# Подписи словарей узла по-русски — для текстов, которые собирает бэк (дельта версий
# документации). Зеркало фронтовых SHAPE_LABEL / APPROVAL_LABEL / DOC_KIND_LABEL
# (components/nodeTerms.ts) и STATUS_META (graph/colors.ts): в таблице «было / стало»
# человек видит те же слова, что на странице объекта.
NODE_SHAPE_LABELS: dict[NodeShape, str] = {
    "service": "Сервис",
    "database": "База данных",
    "broker": "Брокер сообщений",
    "person": "Пользователь",
}
NODE_STATUS_LABELS: dict[NodeStatus, str] = {
    "existing": "Существует",
    "planned": "Проектируется",
    "deprecated": "Выводится",
}
NODE_APPROVAL_LABELS: dict[NodeApproval, str] = {
    "in_progress": "В работе",
    "approved": "Согласовано",
}
NODE_DOC_KIND_LABELS: dict[NodeDocKind, str] = {
    "operation": "Операция",
    "worker": "Воркер",
}
# Элемент архитектуры: хранимый (дельта версий показывает, что поставил человек) и
# действующий (то, чем узел считается сейчас). Хранимого может не быть — подпись
# ELEMENT_UNSET_LABEL: «не сказано» не равно «система», хотя читается так же.
NODE_ELEMENT_LABELS: dict[NodeElement, str] = {
    "system": "Система",
    "container": "Контейнер",
}
ELEMENT_UNSET_LABEL = "Не задан"
NODE_ELEMENT_EFFECTIVE_LABELS: dict[NodeElementEffective, str] = {
    "system": "Система",
    "container": "Контейнер",
    "component": "Компонент",
}

# Роль в проекте (app/access.py): права ВНУТРИ проекта определяет только она. Тот же
# набор держит CHECK в БД (app/models/project_member.py).
ProjectRole = Literal["owner", "editor", "reader"]

# Роль пользователя — право на документацию. Администратор — отдельный признак
# is_admin, а не третья роль (docs/tasks/admin-users.md).
UserRole = Literal["architect", "viewer"]
USER_ROLES: tuple[UserRole, ...] = get_args(UserRole)

# Срок личного токена доступа в днях (app/personal_tokens.py); «бессрочно» — null.
TokenLifetimeDays = Literal[30, 90, 365]

# Режим пометки обращения в тексте схемы логики: «читает:», «пишет:», «публикует:»,
# «потребляет:», «зависит от:».
DataRefMode = Literal["read", "write", "publish", "consume", "config"]

# Итог резолва одной пометки. Статусы табличной и канальной семей разные («таблицы нет»
# и «канала нет» — разные починки), общий у них только «ambiguous».
DataRefStatus = Literal[
    "ok",
    # Табличная семья (read/write).
    "unknown_table",
    "unknown_column",
    # Канальная семья (publish/consume).
    "unknown_channel",
    "unknown_field",
    # Конфигурационная семья (config). Пары «нет параметра / нет члена» у неё нет:
    # параметр плоский, второго уровня не бывает.
    "unknown_param",
    # Общий для табличной и канальной: имя подошло нескольким целям, выбрать за
    # пользователя нельзя. Конфигурации он НЕДОСТУПЕН по построению — искать её
    # можно только у владельца схемы, а там имя уникально (см. data_refs._resolve_config).
    "ambiguous",
]

# Плечо канала в шаге процесса: вызов или ответ.
MessageLeg = Literal["forward", "return"]

# Стиль стрелки шага — производное от плеча и канала: ответ, вызов, событие на
# асинхронном канале или самосообщение (внутренняя операция участника, from == to).
MessageKind = Literal["forward", "return", "async", "self"]

# Вид фрагмента sequence-диаграммы.
FragmentKind = Literal["alt", "opt", "loop", "par"]
FRAGMENT_KINDS: tuple[FragmentKind, ...] = get_args(FragmentKind)


def pick[T: str](value: object, allowed: tuple[T, ...]) -> T | None:
    """value, если он из набора allowed, иначе None — для разбора входа (YAML, шапка
    .mmd, аргументы команды). Отдаёт элемент самого набора: он и несёт Literal-тип,
    а проверка «in» тип str не сужает."""
    for item in allowed:
        if value == item:
            return item
    return None
