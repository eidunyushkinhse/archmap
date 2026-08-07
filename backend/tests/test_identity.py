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
    normalize_image,
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


class TestNormalizeImage:
    def test_тег_и_дайджест_срезаются(self) -> None:
        assert normalize_image("reg.io/org/app:1.2.3") == "reg.io/org/app"
        assert normalize_image("org/app@sha256:abc123") == "org/app"

    def test_порт_реестра_не_срезается(self) -> None:
        # Двоеточие до последнего слэша — порт, а не тег.
        assert normalize_image("registry:5000/org/app:1.2") == "registry:5000/org/app"

    def test_короткое_имя_без_реестра(self) -> None:
        assert normalize_image("payments:latest") == "payments"


class TestSourceKeys:
    def test_порядок_убывания_различающей_силы(self) -> None:
        src = SourceRef(
            repo="github.com/org/repo", image="reg.io/app", deployment="payments", host="payments"
        )
        assert source_keys(src) == [
            "git:github.com/org/repo",
            "img:reg.io/app",
            "k8s:payments",
            "host:payments",
        ]
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
