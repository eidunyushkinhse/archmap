"""Общее у дозаливок ТАБЛИЧНЫХ ФАКТОВ: структуры БД (app/data_import.py), каналов
брокера (app/channels_import.py) и конфигурации сервиса (app/config_import.py).

Три приёмника писались копиями, и копии уже начали расходиться (аудит Q-2: булево в
поле дефолта превращалось в «True» везде, кроме конфигурации). Здесь — то, что у
семей одинаково по смыслу: разбор скаляров пакета, адрес объекта-владельца и
перечень допустимых адресов для текста ошибки. Что у семьи своё (форма владельца —
ошибка или предупреждение, ключ записи, слияние полей), остаётся в её модуле.
"""

import uuid

from app.models.node import Node
from app.node_ref import NodeIndex, qualified_node_hits


def as_bool(v: object) -> bool:
    return v is True or (isinstance(v, str) and v.strip().lower() in {"true", "да", "yes", "1"})


def as_str(v: object) -> str:
    # bool отдельно: str(True) дало бы «True» в поле дефолта, а в YAML агент пишет
    # «false» — и такое значение в карте выглядело бы как чужой язык.
    if isinstance(v, bool):
        return "true" if v else "false"
    return "" if v is None else str(v).strip()


def nodes_hint(index: NodeIndex, shape: str) -> str:
    """Пути объектов формы shape — для текстов ошибок адреса.

    Слабая модель адрес ВЫДУМЫВАЕТ («Zabbix Storage»), а «объект не найден» без
    списка допустимых заставляет её гадать вслепую — раунд переписки за раунд
    (полевой QA, уроки Н8/Н11)."""
    paths = [index.paths[i] for i, n in enumerate(index.flat) if n.shape == shape]
    return ", ".join(paths) if paths else "в проекте их нет"


def resolve_owner(
    ref: str | None,
    fname: str,
    index: NodeIndex,
    window: uuid.UUID | None,
    errors: list[str],
    owners: str,
) -> Node | None:
    """Объект-владелец записей файла по адресу «# archmap-node»: полный путь либо
    голое имя (как в дозаливке доков). Без адреса — объект окна. Промах и
    неоднозначность — строка в errors и None; owners — «узлы-БД проекта: …», чем
    подсказать допустимые адреса."""
    if ref is None:
        if window is None:
            errors.append(f"{fname}: не указан объект, а окно не сказало, к какому применять")
            return None
        for n in index.flat:
            if n.id == window:
                return n
        errors.append(f"{fname}: объект окна не найден")
        return None
    hits = index.by_path.get(ref) or index.by_name.get(ref) or []
    if not hits:
        # ЧАСТИЧНЫЙ путь («Сервис заказов / Order API» при корне «Маркетплейс …»):
        # агент видит только свой репозиторий и корневого контейнера не знает, а
        # промпт как раз просит писать путь. Совпадение по хвосту — по границе « / »,
        # чтобы «…/ Заказы» не цеплялось к «…/ Мои Заказы».
        hits = [i for i, full in enumerate(index.paths) if full.endswith(f" / {ref}")]
    if not hits:
        # Тёзка (одно имя в одном родителе) и его потомки адресуются путём с
        # уточнителем на сегменте тёзки — якорным «@ git:…» или порядковым «@ #N»;
        # так пишут архив и синтетические файлы единого импорта (app/node_ref.py).
        hits = qualified_node_hits(ref, index.flat)
    if not hits:
        errors.append(f"{fname}: объект «{ref}» не найден; {owners}")
        return None
    if len(hits) > 1:
        errors.append(
            f'{fname}: имя «{ref}» неоднозначно ({", ".join(index.paths[i] for i in hits)}) — '
            "укажите полный путь"
        )
        return None
    return index.flat[hits[0]]
