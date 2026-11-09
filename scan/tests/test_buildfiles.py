"""Процессы по файлам сборки, когда манифестов нет (ТЗ §13.4): autotools и cmd/<имя>/ Go."""

from __future__ import annotations

from functools import partial
from pathlib import Path

from archmap_scan import stats, texts, vocab
from archmap_scan.model import Findings
from archmap_scan.parsers import buildfiles
from tests.helpers import FIXTURES, files_of, model_of, time_limit, timed, tree

MAKEFILE = """\
## Process this file with automake to produce Makefile.in

SUBDIRS = poller

sbin_PROGRAMS = zabbix_server  # сервер
bin_PROGRAMS = \\
\tzabbix_get \\
\t$(EXTRA_PROGRAM) @OPTIONAL@ \\
\tzabbix_sender
libexec_PROGRAMS += helper
if WITH_HELPER
libexec_PROGRAMS += helper
endif
noinst_PROGRAMS = internal
check_PROGRAMS = unit_tests
zabbix_server_SOURCES = server.c
"""

GO_MAIN = "package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(1)\n}\n"


def test_programs_with_continuation(tmp_path: Path) -> None:
    assert buildfiles.programs(MAKEFILE) == [
        ("zabbix_server", 5), ("zabbix_get", 7), ("zabbix_sender", 9), ("helper", 10),
        ("helper", 12),
    ]
    ctx, files = files_of(tree(tmp_path, {"src/Makefile.am": MAKEFILE, "src/server.c": ""}))
    found = buildfiles.parse(files, ctx)
    assert [(u.name, str(u.loc), u.language) for u in found.build_units] == [
        ("zabbix_server", "src/Makefile.am:5", "C"), ("zabbix_get", "src/Makefile.am:7", "C"),
        ("zabbix_sender", "src/Makefile.am:9", "C"), ("helper", "src/Makefile.am:10", "C"),
    ]


def _tree(root: Path) -> Path:
    return tree(root, {
        "src/zabbix_server/Makefile.am": "sbin_PROGRAMS = zabbix_server\n",
        "src/zabbix_server/server.c": "int main(void) { return 0; }\n",
        "src/zabbix_server/poller/poller.c": "",
        "src/cli/Makefile.am": "bin_PROGRAMS = cli\n",
        "src/cli/cli.cpp": "int main() {}\n",
        "src/cli/util.c": "",
        "src/libs/zbxcommon/Makefile.am": "noinst_LIBRARIES = libzbxcommon.a\n",
        "hack/Makefile.am": "bin_PROGRAMS = devtool\n",
        "src/go/go.mod": "module example.com/agent2\n",
        # Процесс Go объявляет main в любом файле пакета, а main.go выбирается первым.
        "src/go/cmd/zabbix_agent2/zabbix_agent2.go": GO_MAIN,
        "src/go/cmd/zabbix_agent2/main.go": GO_MAIN,
        "src/go/cmd/zabbix_agent2/config.go": "package main\n",
        "src/go/cmd/mock_server/mock_server.go": GO_MAIN,
        "src/go/cmd/lib_only/lib.go": "package lib\n",
        "src/go/pkg/zbxcomms/comms.go": "package zbxcomms\n",
        # cmd/ не у модуля, не в корне и не под go/: не процесс по соглашению.
        "tools/other/cmd/x/main.go": GO_MAIN,
        "src/zabbix_java/build.xml": "<project/>\n",
    })


def test_containers_from_build_files(tmp_path: Path) -> None:
    model = model_of(_tree(tmp_path))
    got = [(o.name, o.technology, o.code_dir, o.path) for o in model.objects]
    assert got == [
        ("cli", "C++", "src/cli", "src/cli"),
        ("mock_server", "Go", "src/go/cmd/mock_server", "src/go/cmd/mock_server"),
        ("zabbix_agent2", "Go", "src/go/cmd/zabbix_agent2", "src/go/cmd/zabbix_agent2"),
        ("zabbix_server", "C", "src/zabbix_server", "src/zabbix_server"),
    ]
    agent = model.obj("zabbix_agent2")
    assert agent is not None
    assert [str(loc) for loc in sorted(agent.locs)] == ["src/go/cmd/zabbix_agent2/main.go:5"]
    assert model.by_buildfiles and not model.implicit
    fams = stats.families(model, Findings(), {})
    containers = fams["containers"]
    assert containers.notes == [texts.NOTE_BUILDFILES]
    assert containers.unsupported == [texts.STACK_ANT]
    assert containers.status == "partial" and containers.contributed == ["buildfiles"]


def test_only_without_manifests(tmp_path: Path) -> None:
    _tree(tmp_path)
    tree(tmp_path, {"docker-compose.yml": "services:\n  web:\n    image: nginx\n"})
    model = model_of(tmp_path)
    assert [o.name for o in model.objects] == ["web"]
    assert not model.by_buildfiles
    fams = stats.families(model, Findings(), {})
    assert fams["containers"].unsupported == [] and fams["containers"].notes == []


def test_routes_get_owner(tmp_path: Path) -> None:
    tree(tmp_path, {
        "src/go/go.mod": "module example.com/agent2\n",
        "src/go/cmd/web_service/web_service.go": (
            'package main\n\nimport "net/http"\n\nfunc main() {\n'
            '\thttp.HandleFunc("/report", h)\n}\n'
        ),
        "src/go/internal/status/status.go": (
            'package status\n\nimport "net/http"\n\nfunc Start() {\n'
            '\thttp.HandleFunc("/status", h)\n}\n'
        ),
        "src/go/cmd/agent/agent.go": GO_MAIN,
    })
    model = model_of(tmp_path)
    assert [e.path for e in model.http["web_service"]] == ["/report"]
    # Общий код internal/ остаётся общим: контейнеров со своим кодом два.
    assert [(h["name"], h["reason"]) for h in model.hints["unassigned"]] == [
        ("ANY /status", texts.REASON_SHARED_LIB),
    ]


def test_hostile_makefile(tmp_path: Path) -> None:
    # Почти предел размера файла (walk.MAX_BYTES): склейка строк, повторы и длинное слово.
    payload = "bin_PROGRAMS = " + "a \\\n" * 200_000 + "x" * 1_000_000 + "\n"
    ctx, files = files_of(tree(tmp_path, {"src/Makefile.am": payload, "src/a.c": ""}))
    found, took = timed(partial(buildfiles.parse, files, ctx), time_limit())
    assert took < time_limit()
    assert [u.name for u in found.build_units] == ["a"]


def test_bazel_and_cmake_root_markers(tmp_path: Path) -> None:
    """Маркер сборки в корне (ТЗ §15 п. 12 С12). Envoy (C++ на Bazel, MODULE.bazel) получил
    stacks [Rust] от SDK Cargo.toml в корне, а матрица ci/matrix/docker-compose.yml со
    сборкой из корня — объекты на Rust с основаниями Cargo.toml:1 и go.mod:1. При маркере
    Cargo.toml и go.mod — SDK и утилиты: неявного контейнера и процессов cmd/ модулей Go
    нет, имя системы не по go.mod, стек «C++ (Bazel)» первым в stacks и в unsupported
    семьи containers и семей яруса кода, контейнер с корневым каталогом кода получает этот
    стек. Ловушки:
    один Cargo.toml без Bazel по-прежнему неявный контейнер на Rust; CMakeLists.txt в корне
    даёт «C/C++ (CMake)»."""
    model = model_of(FIXTURES / "bazel-root", system=None)
    assert model.objects == [] and model.system == "bazel-root" and model.system_locs == []
    fams = stats.families(model, Findings(), {})
    assert stats.stacks(model) == [vocab.STACK_BAZEL]
    assert fams["containers"].status == "unsupported"
    for fam in ("containers", "config", "channels", "http_routes", "workers", "schedules"):
        assert fams[fam].unsupported == [vocab.STACK_BAZEL]
    # Матрица ci/ с части 2 (ТЗ §15 п. 13 Д4) объектов не даёт и на ступени 2, поэтому стек
    # контейнера со сборкой из корня проверяется на compose в корне.
    model = model_of(FIXTURES / "bazel-compose")
    assert model.objects == [] and [h["name"] for h in model.hints["profiles"]] == [
        "all", "ci/matrix/Dockerfile",
    ]
    tree(tmp_path / "stand", {
        "MODULE.bazel": 'module(name = "proxy")\n', "Cargo.toml": '[package]\nname = "sdk"\n',
        "Dockerfile": "FROM ubuntu:24.04\n",
        "docker-compose.yml": "services:\n  proxy:\n    build: .\n",
    })
    [proxy] = model_of(tmp_path / "stand").objects
    assert (proxy.name, proxy.technology) == ("proxy", vocab.STACK_BAZEL)
    assert sorted(str(loc) for loc in proxy.locs) == ["Dockerfile:1", "docker-compose.yml:2"]
    tree(tmp_path / "rust", {"Cargo.toml": '[package]\nname = "tool"\n'})
    assert [(o.name, o.technology) for o in model_of(tmp_path / "rust").objects] == [
        ("Ярмарка", "Rust"),
    ]
    tree(tmp_path / "cmake", {
        "CMakeLists.txt": "project(app CXX)\n", "Cargo.toml": '[package]\nname = "sdk"\n',
    })
    model = model_of(tmp_path / "cmake")
    assert model.objects == [] and stats.stacks(model) == [vocab.STACK_CMAKE]


def test_cargo_workspace_binaries() -> None:
    """Бинарные крейты Cargo workspace при Dockerfile с ARG BIN (ТЗ §15 п. 14 И1). Найдено в
    PostHog: rust/Cargo.toml (members, 83 члена), rust/Dockerfile:9 ARG BIN и cargo build
    --bin $BIN; в compose не все бинарники (batch-import-worker). Ловушки: библиотечный
    крейт без src/main.rs; член по шаблону tools/* в каталоге с test в имени (манифест
    разработки, в hints.profiles); Dockerfile без ARG BIN (plain/: правило не действует,
    каталог кода прежний); крейт с именем сервиса compose (capture: один объект с каталогом
    крейта вместо общего rust/)."""
    model = model_of(FIXTURES / "cargo-workspace")
    objs = {o.name: o for o in model.objects}
    assert sorted(objs) == ["batch-import-worker", "capture", "plain"]
    assert [(o.code_dir, o.technology, o.role) for o in objs.values()] == [
        ("rust/batch-import-worker", "Rust", vocab.ROLE_WORKER),
        ("rust/capture", "Rust", vocab.ROLE_SERVICE),
        ("plain", "Rust", vocab.ROLE_SERVICE),
    ]
    assert objs["capture"].parsers == ["compose", "buildfiles"]
    assert "rust/capture/Cargo.toml:2" in {str(loc) for loc in objs["capture"].locs}
    assert [(h["name"], h["source"]) for h in model.hints["profiles"]] == [
        ("test-harness", "rust/tools/test-harness/Cargo.toml:2"),
    ]


def test_cargo_bin_arg() -> None:
    """ARG, которым Dockerfile выбирает бинарник: `--bin $BIN`, `--bin ${BIN}`, `--bin=$X`;
    ARG без такого использования и `--bin` с необъявленной переменной не в счёт."""
    assert buildfiles.bin_arg("ARG BIN\nRUN cargo build --bin $BIN\n") == "BIN"
    assert buildfiles.bin_arg("arg APP\nRUN cargo build --bin=${APP}\n") == "APP"
    assert buildfiles.bin_arg("ARG BIN\nRUN cargo build --release\n") is None
    assert buildfiles.bin_arg("RUN cargo build --bin $BIN\n") is None


def test_cargo_hostile_is_fast(tmp_path: Path) -> None:
    """Враждебный Dockerfile и workspace: тысячи ARG и --bin, сотни тысяч членов, шаблоны."""
    many = {f"rust/a/c{i}/Cargo.toml": f'[package]\nname = "c{i}"\n' for i in range(2000)}
    tree(tmp_path, {
        **many,
        "rust/Dockerfile": "ARG B\n" * 100_000 + "RUN cargo build --bin $" * 50_000,
        "rust/Cargo.toml": "[workspace]\nmembers = [" + '"a/*", "b", ' * 100_000 + "]\n",
    })
    ctx, files = files_of(tmp_path)
    _found, took = timed(partial(buildfiles.parse, files, ctx), time_limit())
    assert took < time_limit(), f"{took:.2f} с"
