"""Идентичность узла между прогонами агента (Фаза 0, docs/plan-arch-sync.md).

Зачем: мердж N репозиториев и будущий синк опознают узел по ИМЕНИ, а имя каждый
прогон назначает независимо. Отсюда два симметричных провала: один сервис
расщепляется на два узла (в своём репозитории compose-сервис зовётся «app», а
вызывающие ходят на «payments»), и наоборот — два разных сервиса разных команд,
названные «api», склеиваются МОЛЧА. Ложная склейка хуже дубля: дубль видно
глазами, а склейка выглядит как корректная схема.

Лечение: агент выкладывает в YAML то, чем сервис опознаётся ОБЪЕКТИВНО — git
remote, образ, имя деплоймента, сетевое имя. Здесь эти сырые значения приводятся
к каноническим ключам.

Ключей у узла НЕСКОЛЬКО (набор), а не один, и это принципиально: свой репозиторий
знает про себя git/образ, а вызывающий видит только сетевое имя из URL — общим у
них окажется единственный тип ключа (host).

Решение принимает СИЛЬНЕЙШИЙ ОБЩИЙ тип ключа (compare_identity): совпадение по
слабому ключу не должно перевешивать противоречие по сильному — два сервиса
разных команд, оба названные в своих неймспейсах «api» (host совпал), но живущие
в разных репозиториях (git разошёлся), обязаны остаться разными узлами. Нет
общего типа — модуль честно отвечает «не знаю», и решает имя, как раньше.

Якорь — подсказка матчеру, а НЕ уникальный идентификатор: монорепо легально даёт
один repo на много узлов, поэтому уникальность здесь не проверяется и не требуется.
"""

import re
from dataclasses import dataclass

# Типы ключей в порядке УБЫВАНИЯ различающей силы — им же решается спор при
# сравнении (compare_identity) и им выбирается канонический ключ для
# nodes.source_ref. Сила = насколько ГЛОБАЛЬНО значение уникально: git-remote
# (host/org/repo) и образ с реестром уникальны во вселенной; имя деплоймента —
# только внутри неймспейса; сетевое имя — только внутри сети, зато видно с ОБЕИХ
# сторон вызова, поэтому оно есть, но слабее всех.
KEY_ORDER = ("git", "img", "k8s", "host")

# Схема + креды в git-remote: https://user:token@host/…, ssh://git@host/…
_SCHEME_CREDS = re.compile(r"^[a-z][a-z0-9+.-]*://(?:[^@/]*@)?", re.IGNORECASE)
# scp-подобный синтаксис git: git@github.com:org/repo.git
_SCP_LIKE = re.compile(r"^(?:[^@/\s]+@)?([^:/\s]+):(?!\d)(.+)$")


def _clean(raw: str | None) -> str | None:
    """Схлоп пробелов + нижний регистр; пустое → None."""
    if raw is None:
        return None
    val = " ".join(raw.split()).casefold()
    return val or None


def normalize_repo(raw: str | None) -> str | None:
    """git remote → «host/org/repo» (без схемы, кредов, .git и хвостовых слэшей).

    Принимает https://, ssh://, scp-подобный git@host:org/repo.git и уже
    нормализованную форму — все дают один результат, иначе прогоны из разных
    репозиториев не сойдутся."""
    val = _clean(raw)
    if val is None:
        return None
    val = _SCHEME_CREDS.sub("", val)
    scp = _SCP_LIKE.match(val)
    if scp is not None:
        # git@github.com:org/repo → github.com/org/repo. Порт (host:22/…) отсекает
        # негативный lookahead в _SCP_LIKE — там двоеточие перед цифрами.
        val = f"{scp.group(1)}/{scp.group(2)}"
    val = val.rstrip("/")
    if val.endswith(".git"):
        val = val[: -len(".git")]
    return val.strip("/") or None


def normalize_path(raw: str | None) -> str | None:
    """Путь сервиса внутри репозитория (монорепо): без ведущих «./» и слэшей."""
    val = _clean(raw)
    if val is None:
        return None
    while val.startswith("./"):
        val = val[2:]
    return val.strip("/") or None


def normalize_image(raw: str | None) -> str | None:
    """Docker-образ без тега и дайджеста: «reg:5000/org/app:1.2» → «reg:5000/org/app».

    Тег отделяется двоеточием ПОСЛЕ последнего слэша — двоеточие раньше принадлежит
    порту реестра и срезать его нельзя."""
    val = _clean(raw)
    if val is None:
        return None
    val = val.split("@", 1)[0]  # дайджест @sha256:…
    head, sep, tail = val.rpartition("/")
    last = tail.split(":", 1)[0] if ":" in tail else tail
    val = f"{head}{sep}{last}" if sep else last
    return val.strip("/") or None


@dataclass(frozen=True)
class SourceRef:
    """Чем узел опознаётся вне схемы. Все поля опциональны: агент кладёт то, что
    реально видит в репозитории, и НЕ выдумывает остального."""

    repo: str | None = None  # git remote
    path: str | None = None  # путь сервиса внутри репозитория (монорепо)
    image: str | None = None  # образ из compose/манифеста
    deployment: str | None = None  # имя k8s deployment (можно «namespace/name»)
    host: str | None = None  # сетевое имя: compose-сервис, k8s Service, hostname из URL

    @property
    def empty(self) -> bool:
        return not any((self.repo, self.path, self.image, self.deployment, self.host))


def normalized(src: SourceRef) -> SourceRef:
    """Все поля через свои нормализаторы (идемпотентно)."""
    return SourceRef(
        repo=normalize_repo(src.repo),
        path=normalize_path(src.path),
        image=normalize_image(src.image),
        deployment=_clean(src.deployment),
        host=_clean(src.host),
    )


def source_keys(src: SourceRef | None) -> list[str]:
    """Все ключи узла в порядке убывания различающей силы (KEY_ORDER).

    repo даёт ОДИН ключ: «git:repo#path» при известном пути внутри репозитория,
    иначе «git:repo». Два ключа от одного repo сделали бы монорепо-сервис
    совпадающим с самим репозиторием — то есть со всеми своими соседями."""
    if src is None:
        return []
    n = normalized(src)
    keys: list[str] = []
    if n.repo:
        keys.append(f"git:{n.repo}#{n.path}" if n.path else f"git:{n.repo}")
    if n.image:
        keys.append(f"img:{n.image}")
    if n.deployment:
        keys.append(f"k8s:{n.deployment}")
    if n.host:
        keys.append(f"host:{n.host}")
    return keys


def canonical_key(src: SourceRef | None) -> str | None:
    """Ключ для хранения в nodes.source_ref — сильнейший из набора (или None)."""
    keys = source_keys(src)
    return keys[0] if keys else None


def key_type(key: str) -> str:
    """Тип ключа («git:github.com/org/x#api» → «git»)."""
    return key.split(":", 1)[0]


def _by_type(keys: list[str]) -> dict[str, set[str]]:
    acc: dict[str, set[str]] = {}
    for k in keys:
        acc.setdefault(key_type(k), set()).add(k)
    return acc


def strongest_common_type(a: list[str], b: list[str]) -> str | None:
    """Сильнейший тип ключа, представленный в ОБОИХ наборах (или None)."""
    ta, tb = _by_type(a), _by_type(b)
    return next((t for t in KEY_ORDER if t in ta and t in tb), None)


def compare_identity(a: list[str], b: list[str]) -> str:
    """Один ли это узел: «same» | «different» | «unknown».

    Решает СИЛЬНЕЙШИЙ общий тип ключа — совпадение по слабому не перевешивает
    противоречие по сильному (общий host «api» при разных git — разные сервисы
    двух команд, а не один). Общего типа нет → «unknown»: сравнивать нечего,
    дальше решает имя, как до появления якорей."""
    t = strongest_common_type(a, b)
    if t is None:
        return "unknown"
    ta, tb = _by_type(a), _by_type(b)
    return "same" if ta[t] & tb[t] else "different"
