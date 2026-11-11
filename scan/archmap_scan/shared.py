"""Параметры общего кода готовыми файлами фактов без адреса владельца (ТЗ §7, §15 п. 18 О1).

Правило владельца записей (ТЗ §7, правило 1) не меняется: файл вне каталогов кода всех
контейнеров или в каталоге контейнеров другого языка владельца не получает. Меняется форма
выдачи: вместо подсказки на каждый параметр записи ложатся в файл facts/shared/<единица>.config.yaml
по одному на единицу кода, и агенту или человеку остаётся вписать в первую строку адрес
контейнера, который выполняет этот код.

Единица кода — каталог ближайшего вверх по дереву манифеста сборки языка записи (тот же
поиск, что codebase.owner_packages: у Keycloak quarkus/runtime и quarkus/server, у n8n
packages/cli). Язык записи — по расширению файла, у файлов настроек по их стеку
(application.yml и .properties — Java или Kotlin, appsettings.json — .NET). Файл без языка
(пример окружения, defaults.hjson) относится к пакету своего каталога. Нет пакета — каталог
первого уровня пути, файл в корне — корень репозитория (имя файла root). Одинаковые имена
внутри единицы сливаются по правилам контейнера (codefacts._merge), одно имя в двух единицах
даёт две записи, как у двух контейнеров.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence

from archmap_scan import owners, paths, texts
from archmap_scan.model import Package
from archmap_scan.objects import Model, Param, SharedFile
from archmap_scan.output.facts import file_stem

# Причины, по которым записи параметров идут в файлы общего кода (missing_reason): файл вне
# каталогов кода всех контейнеров и файл в каталоге контейнеров другого языка. Программа
# cmd/<имя>/ без контейнера (Argo CD) остаётся подсказкой: её владелец назван, он не описан.
REASONS = frozenset({texts.REASON_SHARED_LIB, texts.REASON_OTHER_LANGUAGE})
DIR = "facts/shared"
ROOT_STEM = "root"
# Языки файлов настроек по разборщику: у файла без расширения языка.
_PARSER_LANGUAGES: dict[str, tuple[str, ...]] = {
    "spring-config": ("Java", "Kotlin"),
    "appsettings": (".NET",),
}
# Языки одного модуля сборки: исходники Java и Kotlin лежат в модулях Maven и Gradle вместе.
_SAME_MODULE: dict[str, tuple[str, ...]] = {"Java": ("Java", "Kotlin"), "Kotlin": ("Kotlin", "Java")}
_MAX_DEPTH = 64


class Units:
    """Каталоги пакетов по языкам из манифестов сборки (findings.packages)."""

    def __init__(self, packages: Iterable[Package]) -> None:
        self._dirs: set[tuple[str, str]] = set()
        self._any: set[str] = set()
        for pkg in packages:
            self._dirs.add((pkg.language, pkg.dir))
            self._any.add(pkg.dir)

    def unit(self, rel: str, parser: str) -> str:
        """Единица кода записи из файла rel разборщика parser."""
        language = owners.file_language(rel)
        languages = (
            _SAME_MODULE.get(language, (language,)) if language
            else _PARSER_LANGUAGES.get(parser, ())
        )
        folder = paths.parent(rel)
        if languages:
            current = folder
            for _ in range(_MAX_DEPTH):
                if any((lang, current) in self._dirs for lang in languages):
                    return current
                if not current:
                    break
                current = paths.parent(current)
        elif folder in self._any:
            return folder
        return rel.split("/", 1)[0] if "/" in rel else ""


def name_files(folders: Sequence[str]) -> dict[str, str]:
    """Каталог единицы → путь файла facts/shared/<имя>.config.yaml; имя из пути каталога
    (quarkus/runtime → quarkus-runtime), корень — root; совпавшие получают -2, -3."""
    used: set[str] = set()
    out: dict[str, str] = {}
    for folder in sorted(folders):
        stem = file_stem(folder) if folder else ROOT_STEM
        name = f"{stem}.config.yaml"
        n = 2
        while name in used:
            name = f"{stem}-{n}.config.yaml"
            n += 1
        used.add(name)
        out[folder] = f"{DIR}/{name}"
    return out


def add(model: Model, folder: str, name: str, reason: str) -> Param:
    """Параметр name единицы folder (создаётся при первом обращении); reason — причина
    записи без владельца."""
    item = model.shared.setdefault(folder, SharedFile(folder=folder))
    item.reasons.add(reason)
    return item.params.setdefault(name, Param(name=name))


def finish(model: Model) -> None:
    """Пути файлов единиц и подсказка на файл (kind shared_file): путь, причина, первое
    основание, каталог кода и число записей (ТЗ §15 п. 18 О1)."""
    names = name_files(list(model.shared))
    for folder, item in model.shared.items():
        item.path = names[folder]
        first = min(loc for p in item.params.values() for loc in p.locs)
        model.hint("unassigned", {
            "kind": "shared_file", "name": item.path, "reason": "; ".join(sorted(item.reasons)),
            "source": str(first), "folder": paths.show_dir(folder), "records": len(item.params),
        })
