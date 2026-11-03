"""Один запуск сборщика: контекст, перечень файлов, разборщики, сборка, запись вывода."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

from archmap_scan import registry, stats
from archmap_scan.assemble import assemble
from archmap_scan.context import make_context
from archmap_scan.output import agent, facts, outdir, schema, summary
from archmap_scan.output.coverage import Coverage
from archmap_scan.walk import Files, list_files


@dataclass(frozen=True)
class Options:
    path: str = "."
    out: str = "archmap-scan"
    system: str | None = None
    excludes: Sequence[str] = field(default_factory=tuple)
    includes: Sequence[str] = field(default_factory=tuple)
    use_git: bool = True


@dataclass(frozen=True)
class Result:
    out: Path
    coverage: Coverage
    summary: str


def run(opts: Options) -> Result:
    """Обойти репозиторий и записать каталог вывода. Ошибки каталога — OutDirError."""
    ctx = make_context(Path(opts.path), use_git=opts.use_git, system=opts.system)
    out = Path(opts.out).resolve()
    outdir.check(out)
    listing = list_files(ctx, excludes=opts.excludes, includes=opts.includes, skip=(out,))
    files = Files(ctx.root, listing.files)
    findings, errors = registry.collect(files, ctx)
    model = assemble(findings, ctx)

    cov = Coverage(
        repo=ctx.repo,
        commit=ctx.commit,
        stacks=stats.stacks(model),
        families=stats.families(model, findings, errors),
        excluded=listing.excluded,
        too_large=len(files.too_large),
        binary=len(files.binary),
    )
    text = summary.render(cov)
    outdir.prepare(out)
    outdir.write(out, "schema.yaml", schema.render(model, ctx))
    outdir.write(out, "coverage.yaml", cov.render())
    outdir.write(out, "summary.txt", text)
    outdir.write(out, "agent/evidence.yaml", agent.render_evidence(model, ctx))
    outdir.write(out, "agent/hints.yaml", agent.render_hints(model, ctx))
    outdir.write(out, "agent/entrypoints.yaml", agent.render_entrypoints(model, ctx))
    for rel, body in {**facts.tables_files(model, ctx), **facts.config_files(model, ctx)}.items():
        outdir.write(out, rel, body)
    return Result(out=out, coverage=cov, summary=text)
