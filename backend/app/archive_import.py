"""Импорт архива знания: НОВЫЙ проект из zip (Ф4, docs/plan-archive-export.md).

Применение строго по порядку зависимостей: C4 (узлы и связи) → семьи фактов и
доки (адресуются узлами) → спеки → процессы (участники — по узлам, привязки
шагов — по схемам). Слияние с существующим проектом — отдельная задача
(решение груминга в силе).

МАКСИМУМ ПЕРЕИСПОЛЬЗОВАНИЯ: C4 — parse_import/seed_import (гарантия roundtrip),
семьи фактов — существующие толерантные приёмники (build_*_plan/apply_*_plan с
window=None: адрес каждого файла — внутри него), процессы — process_import с
автосопоставлением участников из превью (узел берётся только при ЕДИНСТВЕННОМ
кандидате — выбирать за пользователя нельзя).

ДОКИ — НАПРЯМУЮ, а не через docs_import, по двум причинам: (1) проект пустой,
политика дозаливки (окно-скоуп, перезапись, конфликты слотов) тут не о чем;
(2) docs_import хранит тело ВМЕСТЕ с шапкой — заглушка разведки (пустое тело,
described вычисляется по длине) стала бы «описанной» одной шапкой. Здесь тело
складывается БЕЗ шапки: заглушка приезжает заглушкой (Д4).

Неразрешённый адрес — не поломка импорта: файл уходит в замечания, остальное
применяется (та же норма, что у всех приёмников: деградация видимая).
"""

import io
import uuid
import zipfile
from dataclasses import dataclass, field

import yaml
from sqlalchemy.orm import Session

from app.archive_export import ARCHIVE_FORMAT
from app.channels_import import apply_channels_plan, build_channels_plan
from app.config_import import apply_config_plan, build_config_plan
from app.data_import import NODE_HEADER, apply_data_plan, build_data_plan
from app.import_yaml import parse_import, seed_import
from app.mmd_header import parse_mmd_header, strip_header
from app.models.node import Node
from app.models.node_doc import NodeDoc
from app.models.project import Project
from app.process_import import apply_import as apply_process_import
from app.process_import import build_preview as build_process_preview
from app.processes import node_path
from app.schemas.archive import ArchiveImportResult

# Капы распаковки: архив приходит от пользователя, и zip умеет быть бомбой.
MAX_FILES = 2000
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024


class ArchiveError(Exception):
    """Ошибка, по которой импорт невозможен целиком (кривой zip/манифест/C4).

    Человеческий текст — наружу как detail 400; частичные проблемы сюда не
    попадают, они едут замечаниями в отчёте."""


@dataclass
class _Archive:
    manifest: dict
    files: dict[str, str] = field(default_factory=dict)


def _read_zip(payload: bytes) -> _Archive:
    try:
        zf = zipfile.ZipFile(io.BytesIO(payload))
    except zipfile.BadZipFile as e:
        raise ArchiveError("Файл не читается как zip-архив") from e
    infos = zf.infolist()
    if len(infos) > MAX_FILES:
        raise ArchiveError(f"В архиве больше {MAX_FILES} файлов")
    total = 0
    files: dict[str, str] = {}
    for info in infos:
        if info.is_dir():
            continue
        if info.file_size > MAX_FILE_BYTES:
            raise ArchiveError(f"Файл «{info.filename}» больше {MAX_FILE_BYTES // 2**20} МБ")
        total += info.file_size
        if total > MAX_TOTAL_BYTES:
            raise ArchiveError(f"Распакованный архив больше {MAX_TOTAL_BYTES // 2**20} МБ")
        try:
            files[info.filename] = zf.read(info).decode("utf-8")
        except UnicodeDecodeError as e:
            raise ArchiveError(f"Файл «{info.filename}» — не текст в UTF-8") from e
    raw = files.get("manifest.yaml")
    if raw is None:
        raise ArchiveError("В архиве нет manifest.yaml — это не архив ArchMap")
    try:
        manifest = yaml.safe_load(raw)
    except yaml.YAMLError as e:
        raise ArchiveError("manifest.yaml не разбирается как YAML") from e
    if not isinstance(manifest, dict) or "archmap-archive" not in manifest:
        raise ArchiveError("manifest.yaml без ключа archmap-archive — это не архив ArchMap")
    version = manifest.get("archmap-archive")
    if not isinstance(version, int) or version > ARCHIVE_FORMAT:
        raise ArchiveError(
            f"Архив формата {version!r}, а этот сервер понимает до {ARCHIVE_FORMAT} — "
            "обновите ArchMap"
        )
    return _Archive(manifest=manifest, files=files)


def _listed(archive: _Archive, category: str) -> list[tuple[str, str]]:
    """Файлы категории по манифесту: (имя, содержимое). Пропавший из zip файл —
    в замечания вызывающего, тут просто пропуск не делаем — пусть упадёт KeyError?
    Нет: манифест мог отстать от архива руками человека — вернём то, что есть."""
    out = []
    listed = archive.manifest.get("contents", {}).get(category) or []
    for fname in listed:
        if isinstance(fname, str) and fname in archive.files:
            out.append((fname, archive.files[fname]))
    return out


def import_archive(
    db: Session, payload: bytes, name_override: str | None, user_id: uuid.UUID
) -> tuple[Project, ArchiveImportResult]:
    """Создать проект из архива. Коммит — на вызывающей стороне.

    ArchiveError — импорт невозможен целиком (проект не создаётся); частичные
    промахи (неразрешённый адрес, тёзки путей) — замечаниями в отчёте."""
    archive = _read_zip(payload)
    manifest_project = archive.manifest.get("project") or {}
    contents = archive.manifest.get("contents") or {}
    warnings: list[str] = []

    # ── C4: без узлов не к чему применять остальное — ошибки тут блокируют всё.
    c4_name = contents.get("c4")
    c4_text = archive.files.get(c4_name) if isinstance(c4_name, str) else None
    if not c4_text:
        raise ArchiveError("В архиве нет файла C4 (contents.c4)")
    parsed, errors = parse_import(c4_text)
    if parsed is None:
        raise ArchiveError("C4 из архива не разбирается: " + "; ".join(errors[:5]))

    project = Project(
        id=uuid.uuid4(),
        name=(name_override or "").strip() or str(manifest_project.get("name") or "Из архива"),
        description=manifest_project.get("description"),
        created_by_id=user_id,
        updated_by_id=user_id,
    )
    db.add(project)
    db.flush()
    seed_import(db, project.id, parsed)
    db.flush()

    nodes = db.query(Node).filter(Node.project_id == project.id).all()
    all_nodes = {n.id: n for n in nodes}
    by_path: dict[str, list[Node]] = {}
    for n in nodes:
        by_path.setdefault(node_path(all_nodes, n.id), []).append(n)

    def resolve(path: str | None, fname: str) -> Node | None:
        """Узел по полному пути; промах и тёзки — замечание, файл пропускается."""
        hits = by_path.get(path or "", [])
        if len(hits) == 1:
            return hits[0]
        if not path:
            warnings.append(f"{fname}: нет адреса узла — файл пропущен")
        elif not hits:
            warnings.append(f"{fname}: узел «{path}» не найден — файл пропущен")
        else:
            warnings.append(f"{fname}: путь «{path}» неоднозначен (узлы-тёзки) — файл пропущен")
        return None

    # ── Схемы логики: напрямую, тело БЕЗ шапки (заглушка остаётся заглушкой).
    docs_created = 0
    taken: set[tuple[uuid.UUID, str]] = set()
    for fname, content in _listed(archive, "docs"):
        header = parse_mmd_header(content)
        node = resolve(header.node, fname)
        if node is None:
            continue
        name = header.name or fname.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        if (node.id, name) in taken:
            warnings.append(f"{fname}: схема «{name}» у узла уже есть — файл пропущен")
            continue
        taken.add((node.id, name))
        db.add(NodeDoc(
            node_id=node.id,
            name=name,
            kind=header.kind or "operation",
            operation=header.operation,
            content=strip_header(content).lstrip("\n"),
        ))
        docs_created += 1
    db.flush()

    # ── Семьи фактов: существующие приёмники, window=None (адрес — в файле).
    def run_family(category: str, build, apply):
        files = _listed(archive, category)
        if not files:
            return None
        plan = build(db, nodes, files, None, False)
        apply(db, plan, False)
        return plan.report

    db_report = run_family("db", build_data_plan, apply_data_plan)
    channels_report = run_family("channels", build_channels_plan, apply_channels_plan)
    config_report = run_family("config", build_config_plan, apply_config_plan)

    # ── Спеки: адрес — ведущим комментарием в самом файле; храним без него.
    specs_applied = 0
    for fname, content in _listed(archive, "specs"):
        m = NODE_HEADER.search(content)
        node = resolve(m.group(1) if m else None, fname)
        if node is None:
            continue
        clean = "".join(
            ln for ln in content.splitlines(keepends=True)
            if not ln.lstrip().startswith("# archmap-node:")
        )
        node.openapi_spec = clean
        specs_applied += 1
    db.flush()

    # ── Процессы: имя из манифеста, участники — автосопоставление превью
    #    (узел только при единственном кандидате), привязки шагов — archmap-doc.
    process_results = []
    for entry in archive.manifest.get("contents", {}).get("processes") or []:
        if not isinstance(entry, dict):
            continue
        proc_file = entry.get("file")
        text = archive.files.get(proc_file) if isinstance(proc_file, str) else None
        if not text:
            warnings.append(f"{proc_file}: файла процесса нет в архиве — пропущен")
            continue
        proc_name = str(entry.get("name") or "") or None
        preview = build_process_preview(db, project.id, text, proc_name)
        mapping = {p.alias: p.node_id for p in preview.participants}
        _, result = apply_process_import(db, project.id, text, proc_name, mapping)
        process_results.append(result)

    node_count = len(nodes)
    return project, ArchiveImportResult(
        project_id=project.id,
        project_name=project.name,
        nodes=node_count,
        edges=len(parsed.edges),
        docs_created=docs_created,
        specs_applied=specs_applied,
        db=db_report,
        channels=channels_report,
        config=config_report,
        processes=process_results,
        warnings=warnings,
    )
