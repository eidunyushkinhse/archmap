"""Процессы по файлам сборки, когда манифестов нет (ТЗ §13.4): autotools и cmd/<имя>/ Go."""

from __future__ import annotations

import time
from pathlib import Path

from archmap_scan import stats, texts
from archmap_scan.model import Findings
from archmap_scan.parsers import buildfiles
from tests.helpers import files_of, model_of, time_limit, tree

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
    started = time.perf_counter()
    found = buildfiles.parse(files, ctx)
    assert time.perf_counter() - started < time_limit()
    assert [u.name for u in found.build_units] == ["a"]
