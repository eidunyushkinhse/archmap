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

import io
import re
import uuid
import zipfile
from collections import Counter

import yaml
from sqlalchemy.orm import Session, undefer

from app.export import build_export_ordered
from app.mmd_header import render_header, strip_header
from app.models.broker_channel import BrokerChannel
from app.models.business_process import BusinessProcess
from app.models.config_param import ConfigParam
from app.models.db_table import DbTable
from app.models.edge import Edge
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.node_ref import node_addresses
from app.process_export import detail_to_mermaid
from app.processes import build_process_detail

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


# ── Сборка архива (Ф3): manifest.yaml + файлы категорий в zip ────────────────

# Версия формата архива. Поднимать при несовместимой правке структуры манифеста
# или раскладки файлов; ввозные форматы самих файлов версионируются своей
# толерантностью (неизвестные ключи игнорируются).
ARCHIVE_FORMAT = 1

_UNSAFE = re.compile(r"[^\w\-. ]")


def _participant_key(name: str) -> str:
    """Имя узла так, как его сравнивает сопоставление участника при импорте
    процесса (process_import.match_nodes_by_name): без регистра и краевых пробелов."""
    return name.strip().casefold()


def _fname(index: int, name: str, ext: str) -> str:
    """Имя файла в архиве: индекс + очищенное имя. СМЫСЛА имя не несёт (адрес —
    внутри файла или в манифесте), индекс решает коллизии; читаемый хвост — для
    человека, распаковавшего архив."""
    safe = _UNSAFE.sub("_", name).strip()[:60] or "item"
    return f"{index:03d}-{safe}{ext}"


def build_archive(db: Session, project: Project) -> bytes:
    """Полный архив знания проекта (zip). Состав и порядок применения —
    docs/plan-archive-export.md; раскладка (view_layout) НЕ едет — принципиальное
    решение Р1: ручная раскладка — бонус, а не знание, при импорте её строит ELK.

    Детерминизм: перечни отсортированы, штампы времени в zip фиксированы —
    два архива одного состояния совпадают байт-в-байт (diff архивов читаем)."""
    return build_archive_ordered(db, project)[0]


def build_archive_ordered(db: Session, project: Project) -> tuple[bytes, list[uuid.UUID]]:
    """То же, что build_archive, плюс ПОРЯДОК id узлов в c4.yaml архива.

    Нужен догрузке (unified_into): архив живого проекта едет там входом №0, и по
    этому порядку узел разобранного C4 возвращается к своей ЖИВОЙ записи. Адресация
    путём была бы неверной — тёзки в одном родителе легальны."""
    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    edges = db.query(Edge).filter(Edge.project_id == project.id).all()
    all_nodes = {n.id: n for n in nodes}
    # Адрес узла-владельца в файлах семей — полный путь, а у законных тёзок (путь
    # один на двоих) — путь с уточнителем-якорем «@ git:…» (app/node_ref.py):
    # иначе приёмник пропустил бы файлы обоих как неоднозначные.
    addresses = node_addresses(nodes)

    def path_of(node_id: uuid.UUID) -> str:
        return addresses[node_id]

    files: list[tuple[str, str]] = []  # (имя в архиве, содержимое)
    manifest: dict = {
        "archmap-archive": ARCHIVE_FORMAT,
        "project": {"name": project.name},
    }
    if project.description:
        manifest["project"]["description"] = project.description
    contents: dict = {"c4": "c4.yaml"}
    c4_text, node_order = build_export_ordered(nodes, edges)
    files.append(("c4.yaml", c4_text))

    # Схемы логики — включая заглушки разведки (пустое тело — план работ, Д4).
    docs = (
        db.query(NodeDoc)
        .join(Node, Node.id == NodeDoc.node_id)
        .filter(Node.project_id == project.id)
        .options(undefer(NodeDoc.content))
        .all()
    )
    doc_files = []
    for i, d in enumerate(sorted(docs, key=lambda d: (path_of(d.node_id), d.name)), 1):
        fname = f"docs/{_fname(i, d.name, '.mmd')}"
        doc_files.append(fname)
        files.append((fname, render_doc_mmd(d, path_of(d.node_id))))
    if doc_files:
        contents["docs"] = doc_files

    # Структура БД / каналы брокеров / конфигурация — файл на узел-владельца.
    def family(rows_by_node: dict[uuid.UUID, list], subdir: str, render) -> list[str]:
        out = []
        ordered = sorted(rows_by_node.items(), key=lambda kv: path_of(kv[0]))
        for i, (nid, rows) in enumerate(ordered, 1):
            fname = f"{subdir}/{_fname(i, all_nodes[nid].name, '.yaml')}"
            out.append(fname)
            files.append((fname, render(rows, path_of(nid))))
        return out

    tables: dict[uuid.UUID, list] = {}
    for t in db.query(DbTable).join(Node, Node.id == DbTable.node_id).filter(
        Node.project_id == project.id
    ):
        tables.setdefault(t.node_id, []).append(t)
    if tables:
        contents["db"] = family(tables, "db", render_tables_yaml)

    channels: dict[uuid.UUID, list] = {}
    for c in db.query(BrokerChannel).join(Node, Node.id == BrokerChannel.node_id).filter(
        Node.project_id == project.id
    ):
        channels.setdefault(c.node_id, []).append(c)
    if channels:
        contents["channels"] = family(channels, "channels", render_channels_yaml)

    params: dict[uuid.UUID, list] = {}
    for p in db.query(ConfigParam).join(Node, Node.id == ConfigParam.node_id).filter(
        Node.project_id == project.id
    ):
        params.setdefault(p.node_id, []).append(p)
    if params:
        contents["config"] = family(params, "config", render_config_yaml)

    # Спеки OpenAPI: адрес узла — внутри файла (render_spec_yaml).
    spec_files = []
    with_spec = sorted(
        (n for n in nodes if n.openapi_spec and n.openapi_spec.strip()),
        key=lambda n: path_of(n.id),
    )
    for i, n in enumerate(with_spec, 1):
        fname = f"specs/{_fname(i, n.name, '.yaml')}"
        spec_files.append(fname)
        files.append((fname, render_spec_yaml(n.openapi_spec or "", path_of(n.id))))
    if spec_files:
        contents["specs"] = spec_files

    # Процессы: mermaid не несёт имени процесса — имя едет в манифесте. Участник,
    # чьё имя в проекте не уникально (тёзки, одноимённые узлы разных контейнеров),
    # едет с адресом узла: по голому имени создание из архива его не привяжет.
    # Привязки шагов адресуют схему путём узла с уточнителем тёзки.
    procs = sorted(
        db.query(BusinessProcess).filter(BusinessProcess.project_id == project.id).all(),
        key=lambda p: p.name,
    )
    same_name = Counter(_participant_key(n.name) for n in nodes)
    doc_node_addresses = {d.id: path_of(d.node_id) for d in docs}
    proc_entries = []
    for i, proc in enumerate(procs, 1):
        fname = f"processes/{_fname(i, proc.name, '.mmd')}"
        detail = build_process_detail(db, proc, all_nodes)
        participant_addresses = {
            p.id: path_of(p.node_id)
            for p in detail.participants
            if p.node_id is not None
            and p.node_id in all_nodes
            and same_name[_participant_key(all_nodes[p.node_id].name)] > 1
        }
        proc_entries.append({"file": fname, "name": proc.name})
        files.append(
            (fname, detail_to_mermaid(detail, participant_addresses, doc_node_addresses))
        )
    if proc_entries:
        contents["processes"] = proc_entries

    manifest["contents"] = contents

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for fname, content in [("manifest.yaml", _yaml(manifest)), *files]:
            # Фиксированный штамп времени — детерминизм байтов архива.
            info = zipfile.ZipInfo(fname, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, content)
    return buf.getvalue(), node_order
