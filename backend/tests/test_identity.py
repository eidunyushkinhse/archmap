"""Тесты идентичности узла (app/identity.py, Фаза 0 docs/plan-arch-sync.md).

Проверяют то, ради чего модуль существует: разные записи одного git-remote дают
ОДИН ключ (иначе прогоны в разных репозиториях не сойдутся), монорепо различается
по path, а противоречие ключей одного типа — сигнал «это разные узлы» даже при
совпавших именах.
"""

from app.identity import (
    SourceRef,
    canonical_key,
    compare_identity,
    known_key,
    normalize_host,
    normalize_repo,
    source_keys,
)


class TestNormalizeRepo:
    def test_все_формы_remote_дают_один_ключ(self) -> None:
        forms = [
            "https://github.com/Org/Repo.git",
            "https://user:token@github.com/org/repo",
            "git@github.com:Org/Repo.git",
            "ssh://git@github.com/org/repo/",
            "github.com/org/repo",
        ]
        assert {normalize_repo(f) for f in forms} == {"github.com/org/repo"}

    def test_порт_в_ssh_не_путается_с_scp_синтаксисом(self) -> None:
        assert normalize_repo("ssh://git@host:22/org/repo.git") == "host:22/org/repo"

    def test_пустое_и_none(self) -> None:
        assert normalize_repo(None) is None
        assert normalize_repo("   ") is None


class TestNormalizeHost:
    def test_порт_срезается(self) -> None:
        # «payments» и «payments:8080» — один сервис; прогоны в разных
        # репозиториях пишут его по-разному.
        assert normalize_host("payments:8080") == "payments"
        assert normalize_host("payments") == "payments"

    def test_петлевые_адреса_якорем_не_считаются(self) -> None:
        # Примета машины разработчика, а не сервиса: иначе любые две БД разных
        # систем на дефолтном порту склеились бы по «localhost:5432».
        for raw in ("localhost:5432", "127.0.0.1", "0.0.0.0:8000", "host.docker.internal"):
            assert normalize_host(raw) is None, raw

    def test_ipv6_в_скобках(self) -> None:
        assert normalize_host("[::1]:5432") is None
        assert normalize_host("[2001:db8::1]:80") == "2001:db8::1"

    def test_петлевой_host_не_даёт_ключа(self) -> None:
        assert source_keys(SourceRef(host="localhost:5432")) == []
        # …и не мешает остальным приметам узла.
        keys = source_keys(SourceRef(repo="github.com/org/x", host="localhost:8000"))
        assert keys == ["git:github.com/org/x"]


class TestSourceKeys:
    def test_порядок_убывания_различающей_силы(self) -> None:
        # Видов якоря два: код (git) сильнее имени зависимости (host).
        src = SourceRef(repo="github.com/org/repo", host="payments")
        assert source_keys(src) == ["git:github.com/org/repo", "host:payments"]
        assert canonical_key(src) == "git:github.com/org/repo"

    def test_монорепо_различается_путём(self) -> None:
        a = source_keys(SourceRef(repo="github.com/org/mono", path="services/api"))
        b = source_keys(SourceRef(repo="github.com/org/mono", path="services/worker"))
        assert a == ["git:github.com/org/mono#services/api"]
        assert compare_identity(a, b) == "different"

    def test_repo_с_путём_не_совпадает_с_голым_repo(self) -> None:
        # Иначе сервис монорепо матчился бы с самим репозиторием, то есть со
        # всеми соседями сразу.
        with_path = source_keys(SourceRef(repo="github.com/org/mono", path="services/api"))
        bare = source_keys(SourceRef(repo="github.com/org/mono"))
        assert compare_identity(with_path, bare) == "different"

    def test_пустой_источник(self) -> None:
        assert source_keys(None) == []
        assert source_keys(SourceRef()) == []
        assert canonical_key(SourceRef()) is None


class TestCompareIdentity:
    def test_общий_host_связывает_свой_репозиторий_и_заглушку(self) -> None:
        # Свой репозиторий знает git-remote, вызывающий — только сетевое имя.
        mine = source_keys(SourceRef(repo="github.com/org/payments", host="payments"))
        theirs = source_keys(SourceRef(host="payments"))
        assert compare_identity(mine, theirs) == "same"

    def test_разные_репозитории_при_одном_имени_различны(self) -> None:
        a = source_keys(SourceRef(repo="github.com/team-a/api"))
        b = source_keys(SourceRef(repo="github.com/team-b/api"))
        assert compare_identity(a, b) == "different"

    def test_нет_общего_типа_ключа_ответ_неизвестно(self) -> None:
        a = source_keys(SourceRef(repo="github.com/org/x"))
        b = source_keys(SourceRef(host="x"))
        assert compare_identity(a, b) == "unknown"

    def test_сильный_ключ_перевешивает_совпавший_слабый(self) -> None:
        # Два «api» разных команд: в своих неймспейсах названы одинаково (host
        # совпал), но живут в разных репозиториях — это РАЗНЫЕ сервисы.
        a = source_keys(SourceRef(repo="github.com/team-a/api", host="api"))
        b = source_keys(SourceRef(repo="github.com/team-b/api", host="api"))
        assert compare_identity(a, b) == "different"

    def test_переименование_при_том_же_репозитории(self) -> None:
        # Сервис переименовали между прогонами — якорь держит тождество.
        old = source_keys(SourceRef(repo="github.com/org/payments", host="app"))
        new = source_keys(SourceRef(repo="github.com/org/payments", host="payments"))
        assert compare_identity(old, new) == "same"

    def test_отсутствие_якорей_ничего_не_утверждает(self) -> None:
        assert compare_identity([], []) == "unknown"
        assert compare_identity(source_keys(SourceRef(repo="github.com/org/x")), []) == "unknown"


class TestKnownKey:
    def test_ключ_неизвестного_типа_не_проходит_гвард(self) -> None:
        # Образ и объект k8s были якорями до 2026-09-04: архив и снимок тех
        # времён не должны оживлять вид, которого больше нет.
        assert known_key("img:reg.io/org/app") is None
        assert known_key("k8s:payments") is None
        assert known_key("чушь") is None
        assert known_key(None) is None

    def test_известные_виды_проходят_как_есть(self) -> None:
        assert known_key("git:github.com/org/repo#src/api") == "git:github.com/org/repo#src/api"
        assert known_key("host:payments") == "host:payments"
