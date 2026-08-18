"""Рендеры файлов архива — обратные к ввозным парсерам BYOA (Ф1 архива,
docs/plan-archive-export.md).

ФОРМАТЫ НЕ НОВЫЕ: каждый рендер пишет ровно тот файл, который уже читает
существующий приёмник — схема логики .mmd с шапкой «%% archmap-*» (docs_import),
структура БД / каналы / конфигурация — YAML с адресом «# archmap-node: …»
(data_import / channels_import / config_import), спека OpenAPI — свой текст с тем
же адресным комментарием. Критерий каждой пары — круговой прогон: рендер →
существующий парсер → та же семантика (tests/test_archive_export.py).

Истина метаданных — БД, а не тело: у доков, залитых BYOA, в теле осталась шапка
времён заливки, и схему могли с тех пор переименовать. Рендер снимает старую
шапку (mmd_header.strip_header) и пишет свежую из записи.

Детерминизм: перечни отсортированы (таблицы по схеме и имени, каналы по группе и
имени, параметры по имени; колонки и поля — своим полем order). Два экспорта
одного проекта дают одинаковые байты — иначе diff архивов был бы нечитаем.
"""

import uuid

import yaml

from app.mmd_header import render_header, strip_header
from app.models.broker_channel import BrokerChannel
from app.models.config_param import ConfigParam
from app.models.db_table import DbTable
from app.models.node_doc import NodeDoc

# Адрес узла-владельца — ведущий комментарий, как у всех семей (NODE_HEADER
# в data_import). Решётка обязательна: YAML-ключ адресом не считается.
_NODE_COMMENT = "# archmap-node: {path}\n"


def _yaml(doc: dict) -> str:
    """Единые настройки дампа: без сортировки ключей (порядок осознанный),
    юникод как есть — файлы читает человек, а не только парсер."""
    return yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, default_flow_style=False)


def render_doc_mmd(doc: NodeDoc, node_path: str) -> str:
    """Схема логики → .mmd: свежая шапка из записи + тело без старой шапки.

    Заглушка разведки (пустое тело) остаётся файлом из одной шапки — перечень
    точек входа без описания это план работ, терять его нельзя (Д4)."""
    fields = {"name": doc.name, "kind": doc.kind, "node": node_path}
    if doc.operation:
        fields["operation"] = doc.operation
    body = strip_header(doc.content or "").lstrip("\n")
    return render_header(fields) + body


def render_spec_yaml(spec: str, node_path: str) -> str:
    """Спека OpenAPI → текст как есть + адрес узла ведущим комментарием.

    В пакете BYOA спека адресуется объектом окна — у файла адреса нет вовсе;
    архиву окно неоткуда взять, поэтому адрес едет ВНУТРИ файла, тем же
    комментарием, что у семей фактов (самодостаточность файла — принцип шапок
    mmd). Существующие строки «# archmap-node:» из текста снимаем: истина — БД."""
    lines = [
        ln for ln in spec.splitlines(keepends=True)
        if not ln.lstrip().startswith("# archmap-node:")
    ]
    return _NODE_COMMENT.format(path=node_path) + "".join(lines)


def render_tables_yaml(tables: list[DbTable], node_path: str) -> str:
    """Структура БД → YAML формата data_import (tables: …).

    references пишем строкой «таблица.колонка» — так их читает применение
    (rpartition по точке); цель ищем среди таблиц ЭТОГО узла — чужих FK импорт
    и не создаёт. Неразрешимая ссылка опускается: кривой references хуже
    отсутствующего (испортил бы честные колонки предупреждениями)."""
    col_addr: dict[uuid.UUID, str] = {}
    for t in tables:
        for c in t.columns:
            col_addr[c.id] = f"{t.name}.{c.name}"

    def table_dict(t: DbTable) -> dict:
        d: dict = {"name": t.name}
        if t.schema_name:
            d["schema"] = t.schema_name
        if t.description:
            d["description"] = t.description
        cols = []
        for c in sorted(t.columns, key=lambda c: c.order):
            cd: dict = {"name": c.name}
            if c.type:
                cd["type"] = c.type
            if c.is_primary_key:
                cd["pk"] = True
            if not c.nullable:
                cd["required"] = True
            ref = col_addr.get(c.references_column_id) if c.references_column_id else None
            if ref:
                cd["references"] = ref
            if c.description:
                cd["description"] = c.description
            cols.append(cd)
        if cols:
            d["columns"] = cols
        return d

    ordered = sorted(tables, key=lambda t: (t.schema_name, t.name))
    return _NODE_COMMENT.format(path=node_path) + _yaml({"tables": [table_dict(t) for t in ordered]})


def render_channels_yaml(channels: list[BrokerChannel], node_path: str) -> str:
    """Каналы брокера → YAML формата channels_import (channels: …)."""

    def channel_dict(c: BrokerChannel) -> dict:
        d: dict = {"name": c.name}
        if c.group_name:
            d["group"] = c.group_name
        if c.kind:
            d["kind"] = c.kind
        if c.partition_key:
            d["partition_key"] = c.partition_key
        if c.delivery:
            d["delivery"] = c.delivery
        if c.retention:
            d["retention"] = c.retention
        if c.description:
            d["description"] = c.description
        fields = []
        for f in sorted(c.fields, key=lambda f: f.order):
            fd: dict = {"name": f.name}
            if f.type:
                fd["type"] = f.type
            if f.required:
                fd["required"] = True
            if f.description:
                fd["description"] = f.description
            fields.append(fd)
        if fields:
            d["fields"] = fields
        return d

    ordered = sorted(channels, key=lambda c: (c.group_name, c.name))
    return _NODE_COMMENT.format(path=node_path) + _yaml(
        {"channels": [channel_dict(c) for c in ordered]}
    )


def render_config_yaml(params: list[ConfigParam], node_path: str) -> str:
    """Конфигурация сервиса → YAML формата config_import (config: …).

    default — текст дефолта ИЗ КОДА, значений сред здесь нет по построению
    (их не хранит сама модель, docs/plan-config-docs.md §2.5)."""

    def param_dict(p: ConfigParam) -> dict:
        d: dict = {"name": p.name}
        if p.value_type:
            d["type"] = p.value_type
        if p.required:
            d["required"] = True
        if p.default_value:
            d["default"] = p.default_value
        if p.description:
            d["description"] = p.description
        return d

    ordered = sorted(params, key=lambda p: p.name)
    return _NODE_COMMENT.format(path=node_path) + _yaml(
        {"config": [param_dict(p) for p in ordered]}
    )
