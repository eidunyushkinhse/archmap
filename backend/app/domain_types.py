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

# Вид схемы логики: обе — точки входа (вид «обзор» удалён 2026-08-18). Поле operation
# заполняется только у операций СОБСТВЕННОГО API узла.
NodeDocKind = Literal["operation", "worker"]
NODE_DOC_KINDS: tuple[NodeDocKind, ...] = get_args(NodeDocKind)

# Роль в проекте (app/access.py): права ВНУТРИ проекта определяет только она. Тот же
# набор держит CHECK в БД (app/models/project_member.py).
ProjectRole = Literal["owner", "editor", "reader"]

# Роль пользователя — право на документацию. Администратор — отдельный признак
# is_admin, а не третья роль (docs/tasks/admin-users.md).
UserRole = Literal["architect", "viewer"]
USER_ROLES: tuple[UserRole, ...] = get_args(UserRole)

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

# Вид фрагмента sequence-диаграммы.
FragmentKind = Literal["alt", "opt", "loop", "par"]


def pick[T: str](value: object, allowed: tuple[T, ...]) -> T | None:
    """value, если он из набора allowed, иначе None — для разбора входа (YAML, шапка
    .mmd, аргументы команды). Отдаёт элемент самого набора: он и несёт Literal-тип,
    а проверка «in» тип str не сужает."""
    for item in allowed:
        if value == item:
            return item
    return None
