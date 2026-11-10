"""Роль «брокер и кэш» у брокера Redis (ТЗ §15 п. 18 В2).

Свидетельство кэша (parsers/cachestore.py) принадлежит контейнерам своего файла
(owners.file_owners). Объект Redis, на котором кэш, выбирается так: адрес из переменной
окружения этих контейнеров со словом CACHE в имени (CACHE_REDIS_URL, REDIS_CACHE_URL), иначе
единственный объект Redis, с которым они связаны (связь любого направления). Несколько
объектов без такой переменной дают подсказку «кэш на одном из двух Redis», роль не меняется.
Роль меняется только у брокера (форма broker, роль «брокер»): база «кэш» так и остаётся базой,
форма и технология не меняются. Место свидетельства добавляется к основаниям объекта
(agent/evidence.yaml).
"""

from __future__ import annotations

from collections.abc import Sequence

from archmap_scan import owners, texts, vocab
from archmap_scan.links import hosts_in
from archmap_scan.model import EnvVar, Findings
from archmap_scan.objects import BROKER, Model, Obj

EnvOf = dict[str, list[tuple[EnvVar, str]]]
_TECH = "Redis"
_CACHE_WORD = "CACHE"


def _pointed(owners_: Sequence[Obj], redis: Sequence[Obj], env_of: EnvOf) -> list[Obj]:
    """Объекты Redis по адресам переменных со словом CACHE в окружении контейнеров."""
    by_host = {o.host.lower(): o for o in redis if o.host}
    out: list[Obj] = []
    for owner in owners_:
        for var, _parser in env_of.get(owner.name, []):
            if _CACHE_WORD not in var.name.upper() or var.dynamic or var.value is None:
                continue
            for host, _scheme in hosts_in(var.name, var.value):
                obj = by_host.get(host)
                if obj is not None and obj not in out:
                    out.append(obj)
    return out


def _linked(model: Model, owners_: Sequence[Obj], redis: Sequence[Obj]) -> list[Obj]:
    names = {o.name for o in owners_}
    out: list[Obj] = []
    for link in model.links:
        for near, far in ((link.src, link.dst), (link.dst, link.src)):
            if near.name in names and far in redis and far not in out:
                out.append(far)
    return sorted(out, key=lambda o: o.name)


def apply(model: Model, findings: Findings, containers: Sequence[Obj], env_of: EnvOf) -> None:
    redis = [o for o in model.objects if o.technology == _TECH]
    if not redis:
        return
    for use in sorted(findings.caches, key=lambda c: c.loc):
        owners_ = owners.file_owners(use.loc.path, containers)
        if not owners_:
            continue
        found = _pointed(owners_, redis, env_of) or _linked(model, owners_, redis)
        if len(found) > 1:
            model.hint("unassigned", {
                "kind": "cache", "name": use.marker, "reason": texts.cache_ambiguous(len(found)),
                "source": str(use.loc), "objects": [o.name for o in found],
            })
            continue
        if not found or found[0].shape != BROKER:
            continue
        target = found[0]
        target.role = vocab.ROLE_BROKER_CACHE
        # Только основание объекта: разборщик свидетельств семьи не имеет, и в покрытии
        # брокеров его нет (форма объекта не от него).
        target.locs.add(use.loc)
