"""Каталог facts/ (ТЗ §5.2): файлы фактов в форматах пакетов ArchMap.

Первая строка — адрес владельца «# archmap-node: Система / объект» именами из schema.yaml,
затем шапка с версией сборщика. Имя файла — транслитерация имени объекта латиницей в нижнем
регистре, не-буквы и не-цифры заменены дефисом, и суффикс семьи: orders-db.tables.yaml,
orders.config.yaml. Так файлы называются одинаково на любой ОС.
"""

from __future__ import annotations

from archmap_scan import paths, texts
from archmap_scan.context import Context
from archmap_scan.model import Column
from archmap_scan.objects import Model, Param
from archmap_scan.output import yamlio

_TRANSLIT = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh",
    "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o",
    "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f", "х": "kh", "ц": "ts",
    "ч": "ch", "ш": "sh", "щ": "shch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu",
    "я": "ya",
}


def file_stem(name: str) -> str:
    """Имя объекта → основа имени файла: «Заказы-БД» → «zakazy-bd»."""
    out = []
    for ch in name.lower():
        if "a" <= ch <= "z" or "0" <= ch <= "9":
            out.append(ch)
        elif ch in _TRANSLIT:
            out.append(_TRANSLIT[ch])
        else:
            out.append("-")
    stem = "-".join(part for part in "".join(out).split("-") if part)
    return stem or "object"


def file_names(model: Model, owners: list[str], family: str) -> dict[str, str]:
    """Владелец → имя файла семьи; совпавшие после транслитерации получают -2, -3."""
    used: set[str] = set()
    out: dict[str, str] = {}
    for owner in owners:
        stem = file_stem(owner)
        name = f"{stem}.{family}.yaml"
        n = 2
        while name in used:
            name = f"{stem}-{n}.{family}.yaml"
            n += 1
        used.add(name)
        out[owner] = f"facts/{name}"
    return out


def _head(model: Model, owner: str, ctx: Context) -> str:
    return f"# archmap-node: {model.system} / {owner}\n" + yamlio.header(ctx.repo, ctx.commit)


def _config_items(params: dict[str, Param]) -> list[dict[str, object]]:
    """Записи семьи config по именам. Ключи без известного значения не пишутся."""
    items: list[dict[str, object]] = []
    for name in sorted(params):
        param = params[name]
        item: dict[str, object] = {"name": param.name}
        if param.type:
            item["type"] = param.type
        if param.required:
            item["required"] = True
        if param.default is not None:
            item["default"] = param.default
        if param.description:
            item["description"] = param.description
        items.append(item)
    return items


def config_files(model: Model, ctx: Context) -> dict[str, str]:
    """facts/<контейнер>.config.yaml: путь → текст."""
    owners = [o.name for o in model.objects if model.params.get(o.name)]
    names = file_names(model, owners, "config")
    out: dict[str, str] = {}
    for owner in owners:
        body = yamlio.dump({"config": _config_items(model.params[owner])})
        out[names[owner]] = _head(model, owner, ctx) + body
    return out


def shared_files(model: Model, ctx: Context) -> dict[str, str]:
    """facts/shared/<единица>.config.yaml (ТЗ §15 п. 18 О1): параметры общего кода в формате
    файлов контейнеров, но с пустым адресом в первой строке. Вторая строка просит вписать
    адрес: ArchMap читает адрес и через перевод строки, поэтому файл, поданный без адреса,
    он отвергает текстом «объект «# Впишите…» не найден», а не ввозит к объекту окна. Шапка
    сборщика (версия, repo, commit) идёт в строках 3–5, где её ищет пометка входа ArchMap;
    за ней причина, каталог кода и число записей."""
    out: dict[str, str] = {}
    for item in sorted(model.shared.values(), key=lambda f: f.path):
        head = "\n".join([
            "# archmap-node:",
            f"# {texts.SHARED_FILE_ASK}",
            yamlio.header(ctx.repo, ctx.commit).rstrip("\n"),
            *(f"# {texts.SHARED_FILE_REASON}: {reason}" for reason in sorted(item.reasons)),
            f"# {texts.SHARED_FILE_FOLDER}: {paths.show_dir(item.folder)}",
            f"# {texts.shared_file_records(len(item.params))}",
        ]) + "\n"
        out[item.path] = head + yamlio.dump({"config": _config_items(item.params)})
    return out


def _column(col: Column) -> dict[str, object]:
    item: dict[str, object] = {"name": col.name}
    if col.type:
        item["type"] = col.type
    if col.pk:
        item["pk"] = True
    if col.required is not None:
        item["required"] = col.required
    if col.references:
        item["references"] = col.references
    return item


def tables_files(model: Model, ctx: Context) -> dict[str, str]:
    """facts/<база>.tables.yaml: таблицы базы после всей цепочки миграций."""
    owners = [o.name for o in model.objects if model.tables.get(o.name)]
    names = file_names(model, owners, "tables")
    out: dict[str, str] = {}
    for owner in owners:
        items: list[dict[str, object]] = []
        for table in sorted(model.tables[owner], key=lambda t: (t.schema or "", t.name)):
            item: dict[str, object] = {"name": table.name}
            if table.schema:
                item["schema"] = table.schema
            item["columns"] = [_column(c) for c in table.columns]
            items.append(item)
        out[names[owner]] = _head(model, owner, ctx) + yamlio.dump({"tables": items})
    return out


def channels_files(model: Model, ctx: Context) -> dict[str, str]:
    """facts/<брокер>.channels.yaml: каналы брокера (имя дословно и вид). Поля сообщений
    из кода не извлекаются (ТЗ §6.4), ключ fields не пишется."""
    owners = [o.name for o in model.objects if model.channels.get(o.name)]
    names = file_names(model, owners, "channels")
    out: dict[str, str] = {}
    for owner in owners:
        items: list[dict[str, object]] = [
            {"name": ch.name, "kind": ch.kind}
            for ch in sorted(model.channels[owner].values(), key=lambda c: c.name)
        ]
        out[names[owner]] = _head(model, owner, ctx) + yamlio.dump({"channels": items})
    return out
