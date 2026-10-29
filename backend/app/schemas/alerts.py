"""Алерты незавершённости схемы (app/alerts.py) — контракт панели «Рекомендации»
и сводки MCP. Вынесены из schemas/node.py (аудит Q-42)."""

import uuid
from typing import Literal

from pydantic import BaseModel

from app.schemas.broker_channel import ChannelAccessMode
from app.schemas.db_doc import DataAccessMode


class DisconnectedNodeAlert(BaseModel):
    """Атомарный узел без единой связи («подвисший»)."""
    node_id: uuid.UUID
    node_name: str


class IntermediateEdgeAlert(BaseModel):
    """Связь, у которой хотя бы один конец упирается в промежуточный
    (контейнерный) узел, а не в атомарный."""
    edge_id: uuid.UUID
    label: str | None
    source_id: uuid.UUID
    source_name: str
    target_id: uuid.UUID
    target_name: str
    # какой из концов является промежуточным узлом
    source_is_intermediate: bool
    target_is_intermediate: bool


class DescendantEdgeAlert(BaseModel):
    """Связь между узлом и его СОБСТВЕННЫМ потомком (ребёнком, внуком, любой
    глубины и в любую сторону): вложенность уже выражена иерархией, и стрелка
    ничего к ней не добавляет — её удаляют либо перевешивают на другой узел.

    Отдельный класс от IntermediateEdgeAlert: там конец уточняют до компонента, а
    здесь конец УЖЕ компонент — этого же контейнера, и совет «уточните» бессмыслен."""
    edge_id: uuid.UUID
    label: str | None
    source_id: uuid.UUID
    source_name: str
    target_id: uuid.UUID
    target_name: str
    # Какой конец является ЧАСТЬЮ другого: True — источник внутри приёмника,
    # False — приёмник внутри источника. Одного флага хватает: обоими частями
    # друг друга концы быть не могут.
    source_is_part: bool


class IsolatedGroupAlert(BaseModel):
    """Изолированная группа: связная компонента графа рёбер (≥2 узла),
    не имеющая ни одной связи с другими частями схемы. Считается только
    по рёбрам (иерархия parent_id игнорируется)."""
    node_ids: list[uuid.UUID]
    node_names: list[str]


class ContainerOwnDocsAlert(BaseModel):
    """Контейнер с СОБСТВЕННЫМИ доками/спецификацией/конфигурацией (grandfather): узел стал
    контейнером (появились дети), но логика/спецификация/параметры остались на нём самом.
    Правила контейнеров: логика, спецификации и конфигурация живут на атомарных детях —
    доки распределяют по детям (модалка «Распределить по детям»), параметры
    описывают заново у компонентов, чей код их читает (2026-10-28)."""
    node_id: uuid.UUID
    node_name: str
    has_docs: bool
    has_spec: bool
    has_config: bool


class PersonInsideAlert(BaseModel):
    """Узел-человек (shape=person), вложенный в другой узел. По C4 люди живут на
    контекстном уровне, ВНЕ границы системы: актор не может быть частью
    контейнера. Правило уже требует промпт импорта и предупреждает отчёт
    слияния, но объекты, заведённые РУКАМИ, до этого алерта не проверял никто."""
    node_id: uuid.UUID
    node_name: str
    parent_id: uuid.UUID
    parent_name: str


class DanglingMessageAlert(BaseModel):
    """Сообщение процесса, потерявшее опору в схеме: связь, которой оно шло,
    удалили (edge_id → NULL по ON DELETE SET NULL — удаление связи НЕ сносит
    сообщение, чтобы расхождение было видно, а не происходило тихо).

    Самосообщения сюда не попадают: у внутренней операции участника связи C4 и
    не было (valid всегда true)."""
    process_id: uuid.UUID
    process_name: str
    message_id: uuid.UUID
    caption: str | None
    from_name: str
    to_name: str


class UnboundParticipantAlert(BaseModel):
    """Участник процесса без узла схемы (node_id = NULL). Появляется двумя путями:
    импортом диаграммы, где имя не сопоставили ни с одним узлом, и удалением узла —
    FK гасит ссылку (SET NULL), процесс переживает удаление вместо того, чтобы молча
    лишиться участника и всех его шагов.

    Вторая ось «незадокументированности», симметричная повисшему сообщению: линия
    жизни на схеме процесса есть, а объекта архитектуры за ней нет."""
    process_id: uuid.UUID
    process_name: str
    participant_id: uuid.UUID
    name: str  # имя из диаграммы либо имя узла на момент, когда он ещё был


class OrphanLegAlert(BaseModel):
    """Шаг процесса, чьё ПЛЕЧО у канала исчезло, хотя сама связь на месте.

    Единственный способ это получить — сменить синхронность канала на асинхронную
    после того, как шаг-ответ уже создан: у асинхронного канала плеча «ответ» нет
    (legs_for_edge), и create_message такое отклоняет, а существующее переживало
    смену молча. Отдельно от «сообщений без связи» (AL26) потому, что чинится
    иначе: «Восстановить связи» тут бессильна — она ищет канал повисшему шагу, а
    здесь канал есть.
    """
    process_id: uuid.UUID
    process_name: str
    message_id: uuid.UUID
    caption: str | None
    # Метка канала, у которого пропало плечо — по ней связь узнают на схеме.
    edge_label: str | None
    from_name: str
    to_name: str


class UnlinkedMessageAlert(BaseModel):
    """Шаг процесса без привязки к схеме логики (doc_id = NULL) — алерт ПОЛНОТЫ.

    Решение Р4 (2026-08-18): замечание на ЛЮБОЙ непривязанный шаг, не различая
    «не привязывали» и «схему удалили» (ON DELETE SET NULL гасит ссылку молча) —
    «шумно, зато консистентно». Это не «сломалось», а «шаг не документирован» —
    та же семья, что «не описана» у разведки: класс стартует со всех шагов
    проекта и гаснет работой по привязке. Самосообщения участвуют наравне:
    внутренняя операция участника тоже документируется схемой логики."""
    process_id: uuid.UUID
    process_name: str
    message_id: uuid.UUID
    caption: str | None
    from_name: str
    to_name: str


class UndescribedDocsAlert(BaseModel):
    """Объект с неописанными схемами логики (AL35) — алерт ПОЛНОТЫ.

    Заглушка разведки — строка перечня точек входа без тела (docs/plan-recon.md):
    не схема, а обещание её написать. ОДНА запись на объект, а не на заглушку:
    после разведки монолита заглушек две сотни, и панель алертов из двухсот строк —
    стена, а не сигнал; построчный бэклог живёт на странице объекта (блок
    «Не описано» под чертой в «Логике»). count — сколько заглушек у объекта."""
    node_id: uuid.UUID
    node_name: str
    count: int


class UnresolvedDataRefAlert(BaseModel):
    """Пометка «читает:/пишет:» в схеме логики, не нашедшая свою таблицу.

    Пометка — ОБЕЩАНИЕ ФАКТА (пивот §9 plan-db-docs.md): текст утверждает, что
    операция трогает такие-то данные. Невыполненное обещание молчать не должно —
    обратный индекс базы нерезолвнутую пометку не показывает вовсе, а обращение с
    несуществующей колонкой показывает как обращение к таблице ЦЕЛИКОМ, и алерт
    остаётся единственным местом, где расхождение текста со структурой видно.
    """

    # Узел-ВЛАДЕЛЕЦ дока (вызывающий), а не база: чинят текст пометки у него.
    node_id: uuid.UUID
    node_name: str
    doc_id: uuid.UUID
    doc_name: str
    ref: str  # ссылка как написана в тексте
    mode: DataAccessMode
    # Почему не срослось: таблицы нет / имя подходит нескольким целям / колонки нет
    # в найденной таблице. Зеркало app.data_refs.RefStatus без «ok».
    reason: Literal["unknown_table", "ambiguous", "unknown_column"]


class UnresolvedChannelRefAlert(BaseModel):
    """Пометка «публикует:/потребляет:» в схеме логики, не нашедшая свой канал.

    ОТДЕЛЬНЫЙ класс, а не расширение AL29 (решение §7.4 plan-broker-docs.md): у
    каналов свой каталог, свои причины и свои слова починки — «укажите „Брокер /
    канал“» вместо «„БД / таблица“». Смешать их значило бы предложить инженеру
    искать топик в структуре базы.
    """

    # Узел-ВЛАДЕЛЕЦ дока (публикующий/потребляющий), а не брокер: чинят текст у него.
    node_id: uuid.UUID
    node_name: str
    doc_id: uuid.UUID
    doc_name: str
    ref: str  # ссылка как написана в тексте
    mode: ChannelAccessMode
    # Почему не срослось: канала нет / имя подходит нескольким / поля нет в канале.
    reason: Literal["unknown_channel", "ambiguous", "unknown_field"]


class UnresolvedConfigRefAlert(BaseModel):
    """Пометка «зависит от:» в схеме логики, не нашедшая параметра конфигурации.

    Третий отдельный класс по той же причине, что и второй: своя починка — «опишите
    ручку в разделе „Конфигурация“ этого объекта или поправьте имя». Ни поля reason,
    ни поля mode здесь НЕТ, и это не экономия: у семьи ровно одна причина промаха
    (параметра с таким именем у объекта нет) и ровно один режим — неоднозначность и
    «нет члена» невозможны по построению (docs/plan-config-docs.md §3).

    ⚠️ Класс заведомо ловит и ПРОЗУ: «зависит от: нагрузки» — обычная русская фраза,
    а не ссылка. Так и задумано (маркер с двоеточием — обещание факта), поэтому текст
    замечания в интерфейсе обязан подсказывать оба выхода: описать параметр либо
    переписать фразу без двоеточия.
    """

    # Узел-ВЛАДЕЛЕЦ дока: он же и владелец параметра — искать негде больше.
    node_id: uuid.UUID
    node_name: str
    doc_id: uuid.UUID
    doc_name: str
    ref: str  # ссылка как написана в тексте


class BrokerEdgeChannelAlert(BaseModel):
    """Связь с брокером, которая не называет канал либо называет несуществующий.

    Решение пользователя №4 (docs/plan-broker-docs.md §4): стрелка «сервис → брокер»
    ОБЯЗАНА назвать топик/очередь — без этого схема не отвечает на «откуда взялось
    событие». Канал на связи — ссылка по ИМЕНИ, а не FK, поэтому шов держит алерт:
    `missing` — канал не указан вовсе, `unknown` — указан, но структура брокера-конца
    такого канала не знает (опечатка либо канал не описан).
    """

    edge_id: uuid.UUID
    source_name: str
    target_name: str
    # Конец-БРОКЕР, по чьей структуре искали канал (оба конца брокеры — назван первый:
    # искали у обоих, и починка начинается с любого).
    broker_name: str
    # Как написано на связи; null — не указан вовсе (reason=missing).
    channel: str | None = None
    reason: Literal["missing", "unknown"]


class AlertsResponse(BaseModel):
    disconnected_nodes: list[DisconnectedNodeAlert] = []
    intermediate_edges: list[IntermediateEdgeAlert] = []
    isolated_groups: list[IsolatedGroupAlert] = []
    container_own_docs: list[ContainerOwnDocsAlert] = []
    persons_inside: list[PersonInsideAlert] = []
    dangling_messages: list[DanglingMessageAlert] = []
    unbound_participants: list[UnboundParticipantAlert] = []
    orphan_legs: list[OrphanLegAlert] = []
    unresolved_data_refs: list[UnresolvedDataRefAlert] = []
    # Дефолт [] обязателен: старые клиенты (в т.ч. MCP-сервер пользователя) читают
    # ответ, ничего не зная о новом классе, и обязательное поле сломало бы их.
    unresolved_channel_refs: list[UnresolvedChannelRefAlert] = []
    # Связи с брокером без канала / с неизвестным каналом (AL31) — дефолт [] по той же
    # причине.
    broker_edge_channels: list[BrokerEdgeChannelAlert] = []
    # Связи узла с собственным потомком (AL32) — дефолт [] по той же причине.
    descendant_edges: list[DescendantEdgeAlert] = []
    # Пометки «зависит от:», не нашедшие параметра (AL33) — дефолт [] по той же причине.
    unresolved_config_refs: list[UnresolvedConfigRefAlert] = []
    # Шаги процессов без привязки к схеме логики (AL34) — дефолт [] по той же причине.
    unlinked_messages: list[UnlinkedMessageAlert] = []
    # Объекты с неописанными схемами логики (AL35) — дефолт [] по той же причине.
    undescribed_docs: list[UndescribedDocsAlert] = []


# --- Перенос grandfather-доков/спеки контейнера на его детей («Распределить по детям») ---
