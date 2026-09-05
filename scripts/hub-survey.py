# Обзор метрик формы по всем уровням реальных проектов (перф-эпик, Ф1; v3
# после ревью Qwen и Δ-замеров). Семантика сцены — БОЕВАЯ (валидирована против
# захваченных входов конвейера: 11/12 сцен совпали по узлам, 12-я — омонимия
# имени уровня): направленные мастер-рёбра как groupMap, конец в контейнер
# уровня исключён (isFrameEnd), гость поднят до верхнего не-предка (projectGhosts).
# Метрики: hub1/hub2 directed и undirected, диаметр undirected, доля листьев.
# Правило формы v2 читает h1u и диаметр (см. docs/plan-renderer-perf.md).
import sys, json, urllib.request
sys.path.insert(0, 'backend')
from app.auth import create_access_token

TOK = create_access_token({'sub': 'admin', 'role': 'viewer'})
BASE = 'http://localhost:8000/api/v1'
def api(path, pid=None):
    req = urllib.request.Request(BASE + path, headers={
        'Authorization': f'Bearer {TOK}', **({'X-Project-Id': pid} if pid else {})})
    return json.load(urllib.request.urlopen(req))

PROJECTS = ['Zabbix 7 Эталон', 'Sentry Эталон', 'Zulip Эталон', 'Grafana Эталон',
            'Zabbix+Grafana Эталон', 'Маркетплейс «Ярмарка» v2']
projects = {p['name']: p['id'] for p in api('/projects') if not p['archived_at']}
rows = []
for pname in PROJECTS:
    pid = projects.get(pname)
    if not pid: continue
    nodes = api('/nodes/all', pid); edges = api('/edges', pid)
    by_id = {n['id']: n for n in nodes}
    parent = {n['id']: n['parent_id'] for n in nodes}
    kids = {}
    for n in nodes: kids.setdefault(n['parent_id'], []).append(n['id'])
    def chain(x):
        out = []
        while x is not None: out.append(x); x = parent.get(x)
        return out
    for lvl in [None] + [n['id'] for n in nodes if kids.get(n['id'])]:
        members = set(kids.get(lvl, []))
        anc = set(chain(lvl)[1:]) if lvl else set()
        def display(x):
            ch = chain(x)
            if lvl is None: return ch[-1]
            if x == lvl: return lvl
            if lvl in ch: return ch[ch.index(lvl) - 1]
            for cand in reversed(ch):
                if cand not in anc: return cand
            return x
        dpairs = set()
        for e in edges:
            a, b = display(e['source_id']), display(e['target_id'])
            if a == b or (lvl is not None and (a == lvl or b == lvl)): continue
            if lvl is not None and a not in members and b not in members: continue
            dpairs.add((a, b))
        upairs = {tuple(sorted(p)) for p in dpairs}
        Ed, Eu = len(dpairs), len(upairs)
        if Ed < 5: continue
        degd, degu, adj = {}, {}, {}
        for a, b in dpairs:
            degd[a] = degd.get(a, 0) + 1; degd[b] = degd.get(b, 0) + 1
        for a, b in upairs:
            degu[a] = degu.get(a, 0) + 1; degu[b] = degu.get(b, 0) + 1
            adj.setdefault(a, set()).add(b); adj.setdefault(b, set()).add(a)
        topd = sorted(degd.values(), reverse=True)
        topu = sorted(degu.values(), reverse=True)
        # диаметр: макс эксцентриситет BFS по всем вершинам (граф мелкий)
        diam = 0
        for s in adj:
            seen = {s: 0}; q = [s]
            while q:
                cur = q.pop(0)
                for nb in adj[cur]:
                    if nb not in seen: seen[nb] = seen[cur] + 1; q.append(nb)
            diam = max(diam, max(seen.values()))
        leaves = sum(1 for v in degu.values() if v == 1) / len(degu)
        name = '(корень)' if lvl is None else by_id[lvl]['name']
        rows.append((pname[:12], name, lvl is None, len(degu), Ed, Eu,
                     topd[0]/Ed, topu[0]/Eu, (topu[0]+(topu[1] if len(topu)>1 else 0))/Eu,
                     diam, leaves))
rows.sort(key=lambda r: -r[7])
print(f"{'проект':12} {'уровень':26} {'кор':3} {'узл':>3} {'Ed':>3} {'Eu':>3} {'h1d':>5} {'h1u':>5} {'h2u':>5} {'диам':>4} {'лист':>5}")
for r in rows:
    print(f"{r[0]:12} {r[1][:26]:26} {'ДА' if r[2] else '—':3} {r[3]:3} {r[4]:3} {r[5]:3} {r[6]:5.2f} {r[7]:5.2f} {r[8]:5.2f} {r[9]:4} {r[10]:5.2f}")
