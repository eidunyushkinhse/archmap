# Обзор «доли хаба» по всем уровням реальных проектов (перф-эпик, Ф1):
# для каждого уровня строится приближённая отображаемая сцена (подъём концов
# рёбер к прямому ребёнку уровня / верхнему предку гостя, слияние направлений),
# метрики: доля рёбер самого связного узла (hub1) и двух самых связных (hub2).
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
    if not pid:
        print(f'НЕТ ПРОЕКТА: {pname}', file=sys.stderr); continue
    nodes = api('/nodes/all', pid)
    edges = api('/edges/', pid)
    by_id = {n['id']: n for n in nodes}
    parent = {n['id']: n['parent_id'] for n in nodes}
    kids = {}
    for n in nodes: kids.setdefault(n['parent_id'], []).append(n['id'])

    def chain(x):  # x и все предки до корня
        out = []
        while x is not None:
            out.append(x); x = parent.get(x)
        return out

    def inside(x, c):  # x в поддереве c?
        return c in chain(x)[1:] or x == c

    levels = [None] + [n['id'] for n in nodes if kids.get(n['id'])]
    for lvl in levels:
        members = kids.get(lvl, [])
        mset = set(members)
        def display(x):
            ch = chain(x)
            if lvl is None:
                return ch[-1]  # верхний предок (корневой узел)
            if lvl in ch and x != lvl:
                # внутри уровня: прямой ребёнок уровня на пути к x
                i = ch.index(lvl)
                return ch[i-1]
            # гость: его верхний контейнер (не внутри уровня)
            return ch[-1]
        pairs = set()
        for e in edges:
            a, b = display(e['source_id']), display(e['target_id'])
            if a == b: continue
            # сцена уровня: хотя бы один конец — член уровня
            if lvl is not None and a not in mset and b not in mset: continue
            pairs.add((a, b))
        # слияние направлений (мастер-рёбра считают форму, не дубли)
        und = {tuple(sorted(p)) for p in pairs}
        E = len(und)
        if E < 5: continue  # мелкие уровни — метрика шумит, форма не важна
        deg = {}
        for a, b in und:
            deg[a] = deg.get(a, 0) + 1
            deg[b] = deg.get(b, 0) + 1
        top = sorted(deg.values(), reverse=True)
        name = '(корень)' if lvl is None else by_id[lvl]['name']
        rows.append((pname, name, lvl is None, len(deg), E, top[0]/E, (top[0]+(top[1] if len(top)>1 else 0))/E))

rows.sort(key=lambda r: -r[5])
print(f"{'проект':28} {'уровень':30} {'кор':3} {'узл':>3} {'рёб':>4} {'hub1':>5} {'hub2':>5}")
for pname, name, is_root, n, e, h1, h2 in rows:
    print(f"{pname[:28]:28} {name[:30]:30} {'ДА' if is_root else '—':3} {n:3} {e:4} {h1:5.2f} {h2:5.2f}")
