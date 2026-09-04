"""Идентичность узла между прогонами агента (Фаза 0, docs/plan-arch-sync.md;
два вида якоря — docs/plan-anchor-ux.md, решение пользователя 2026-09-04).

Зачем: мердж N репозиториев и синк опознают узел по ИМЕНИ, а имя каждый прогон
назначает независимо. Отсюда два симметричных провала: один сервис расщепляется
на два узла (в своём репозитории compose-сервис зовётся «app», а вызывающие ходят
на «payments»), и наоборот — два разных сервиса разных команд, названные «api»,
склеиваются МОЛЧА. Ложная склейка хуже дубля: дубль видно глазами, а склейка
выглядит как корректная схема.

Лечение: агент выкладывает в YAML то, чем узел опознаётся ОБЪЕКТИВНО, и здесь эти
сырые значения приводятся к каноническим ключам. ВИДОВ ЯКОРЯ ДВА:
  • КОД — репозиторий и путь внутри него («git:repo#path» / «git:repo»);
    у компонентов, чей код лежит в продукте;
  • ИМЯ ЗАВИСИМОСТИ — как продукт САМ называет зависимость, у которой своего кода
    в продукте нет (база, брокер, соседний продукт): имя compose-сервиса, имя
    k8s Service, hostname из URL зависимости («host:name»).

Принцип отбора видов: ArchMap описывает ПРОДУКТ, а не КОНТУР РАЗВЁРТЫВАНИЯ (тот же
принцип, что у конфигурации: «значений сред не храним, только дефолт из кода»).
Поэтому образ контейнера и объект Kubernetes якорями БОЛЬШЕ НЕ СЧИТАЮТСЯ (были
«img:»/«k8s:» до 2026-09-04): это приметы того, как продукт где-то развёрнут, а не
того, чем он является. По той же причине петлевые адреса и адреса конкретных
серверов якорем не считаются (_LOOPBACK): они принадлежат среде.

Ключей у узла может быть НЕСКОЛЬКО (набор), а не один, и это принципиально: свой
репозиторий знает про себя git, а вызывающий видит только имя зависимости из URL —
общим у них окажется единственный тип ключа (host).

Решение принимает СИЛЬНЕЙШИЙ ОБЩИЙ тип ключа (compare_identity): совпадение по
слабому ключу не должно перевешивать противоречие по сильному — два сервиса
разных команд, оба названные в своих неймспейсах «api» (host совпал), но живущие
в разных репозиториях (git разошёлся), обязаны остаться разными узлами. Нет
общего типа — модуль честно отвечает «не знаю», и решает имя, как раньше.

ОДИН РЕЖИМ СРАВНЕНИЯ: этой иерархией живут и СИНК (sync_plan), и МЕРДЖ импорта
(_compare_anchors в import_merge — тонкая обёртка над compare_identity). У
мерджа был свой мягкий режим («совпадение ЛЮБОГО якорного поля гасит
противоречие остальных», docs/plan-federation-tuning.md П3), и его снял К3
второй итерации тюнинга (docs/plan-tuning-round2.md, находка 3 матрицы
docs/qa-federation-matrix.md): мягкое правило склеило плагин с ядром продукта по
общему сетевому имени при разных repo. То, ради чего мягкость вводилась, держит
и строгая иерархия: у ЗАГЛУШКИ соседа repo нет вовсе, общим типом остаётся host,
и с продуктом она склеивается как прежде.

Якорь — подсказка матчеру, а НЕ уникальный идентификатор: монорепо легально даёт
один repo на много узлов, поэтому уникальность здесь не проверяется и не требуется.
"""

import re
from dataclasses import dataclass

# Типы ключей в порядке УБЫВАНИЯ различающей силы — им же решается спор при
# сравнении (compare_identity) и им выбирается канонический ключ для
# nodes.source_ref. Сила = насколько ГЛОБАЛЬНО значение уникально: git-remote
# (host/org/repo) уникален во вселенной; имя зависимости — только внутри сети
# продукта, зато видно с ОБЕИХ сторон вызова, поэтому оно есть, но слабее кода.
# Больше двух видов здесь быть не должно: всё, что описывает контур развёртывания
# (образ, объект k8s), из идентичности убрано (docs/plan-anchor-ux.md).
KEY_ORDER = ("git", "host")

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


# Петлевые адреса: «localhost:5432» — примета машины разработчика, а не сервиса.
# Любая БД любой системы на дефолтном порту даст такой же ключ, и два разных узла
# склеились бы по нему (найдено прогоном по репозиторию без compose 2026-08-07).
_LOOPBACK = frozenset({"localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]", "host.docker.internal"})


def normalize_host(raw: str | None) -> str | None:
    """Имя зависимости без порта; петлевые адреса якорем НЕ считаются (None).

    Это имя, под которым продукт САМ называет зависимость в своих манифестах и
    дефолтах: имя compose-сервиса, имя k8s Service, hostname из URL зависимости.
    Порт срезается намеренно: «payments» и «payments:8080» — один сервис, а
    прогоны в разных репозиториях пишут его по-разному. Петлевые адреса и адреса
    конкретных серверов — примета СРЕДЫ, а не продукта, и якорем не становятся."""
    val = _clean(raw)
    if val is None:
        return None
    bare = val.rsplit("]", 1)[0].lstrip("[") if val.startswith("[") else val.split(":", 1)[0]
    if not bare or bare in _LOOPBACK:
        return None
    return bare


@dataclass(frozen=True)
class SourceRef:
    """Чем узел опознаётся вне схемы — сырые приметы ДВУХ видов якоря.

    Все поля опциональны: агент кладёт то, что реально видит в репозитории, и НЕ
    выдумывает остального. repo/path — вид «код», host — вид «имя зависимости»."""

    repo: str | None = None  # git remote
    path: str | None = None  # путь компонента внутри репозитория (монорепо)
    host: str | None = None  # имя зависимости: compose-сервис, k8s Service, hostname из URL

    @property
    def empty(self) -> bool:
        return not any((self.repo, self.path, self.host))


def normalized(src: SourceRef) -> SourceRef:
    """Все поля через свои нормализаторы (идемпотентно)."""
    return SourceRef(
        repo=normalize_repo(src.repo),
        path=normalize_path(src.path),
        host=normalize_host(src.host),
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


def known_key(key: str | None) -> str | None:
    """Гвард точек ЗАПИСИ nodes.source_ref: ключ известного вида — или None.

    Данные приходят снаружи и могли быть сформированы прежней моделью якоря
    (архив, снимок отката, копия проекта, план синка): ключ «img:…»/«k8s:…» в
    nodes.source_ref оживил бы вид, которого больше нет, — тождество решалось бы
    по примете контура развёртывания. Пусто честнее: узел опознаётся по имени,
    как и всякий узел без якоря."""
    if key is None:
        return None
    return key if key_type(key) in KEY_ORDER else None


def source_ref_dict(key: str) -> dict[str, str]:
    """Канонический ключ хранения → словарь блока source формата импорта.

    Обратная сторона source_keys — нужна ЭКСПОРТУ (Ф0 архива, Д1) и карточке
    объекта (поле «Якорь», docs/plan-anchor-ux.md): чтобы якорь пережил круговой
    прогон, экспорт пишет тот же словарь repo/path/host, из которого импорт
    соберёт РОВНО ТОТ ЖЕ ключ (нормализация идемпотентна, хранится уже
    нормализованное). Неизвестный префикс — пусто: не написать якорь лучше, чем
    написать кривой, деградация та же, что при прогоне без якорей (тождество
    решит имя). Сюда же попадают ключи снятых видов («img:»/«k8s:» из архивов,
    сделанных до 2026-09-04)."""
    if key.startswith("git:"):
        repo, sep, path = key[4:].partition("#")
        out = {"repo": repo}
        if sep:
            out["path"] = path
        return out
    if key.startswith("host:"):
        return {"host": key[5:]}
    return {}


def _by_type(keys: list[str]) -> dict[str, set[str]]:
    acc: dict[str, set[str]] = {}
    for k in keys:
        acc.setdefault(key_type(k), set()).add(k)
    return acc


def strongest_common_type(a: list[str], b: list[str]) -> str | None:
    """Сильнейший тип ключа, представленный в ОБОИХ наборах (или None)."""
    ta, tb = _by_type(a), _by_type(b)
    return next((t for t in KEY_ORDER if t in ta and t in tb), None)


def merge_key_sets(a: list[str], b: list[str]) -> list[str]:
    """Объединение наборов склеенных узлов: дедуп + порядок по убыванию силы.
    Прогоны видят разные грани одного сервиса (свой репозиторий — git, вызывающий —
    host), и склеенный узел обязан унаследовать обе, иначе третий файл не найдёт
    его по той грани, которой не досталось."""
    out: list[str] = []
    for k in (*a, *b):
        if k not in out:
            out.append(k)
    order = {t: i for i, t in enumerate(KEY_ORDER)}
    return sorted(out, key=lambda k: (order.get(key_type(k), len(order)), k))


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
