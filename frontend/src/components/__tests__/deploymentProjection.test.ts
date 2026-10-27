// Проекция графа развёртывания на холст (docs/specs/deployment.md): вложенность
// площадок, экземпляры с пометками «i/n», группа «Размещение не указано», правило
// ближайших экземпляров для связей, пустая площадка карточкой, правило цельного
// контейнера (представители), реестр концов и подъём связи к свёрнутой площадке,
// глубина цвета карточки — архитектурная глубина узла (D9).
import { describe, it, expect } from "vitest";
import {
  projectDeployment, siteKey, instanceKey, UNPLACED, UNPLACED_NAME, cardsOf, pickedSite,
} from "../deployment/deploymentProjection";
import { computeViewLayout } from "../graph/layout/pipeline";
import type { DeploymentGraph, DeploymentNode, SiteKind, SiteOut } from "../../types";

function site(id: string, parent_id: string | null = null, kind: SiteKind = "kubernetes", technology: string | null = null): SiteOut {
  return { id, name: id, kind, technology, description: null, parent_id, version: 1, instance_count: 0 };
}
// Объект графа: instances — его площадки (у контейнера — где стоят все его объекты).
function obj(id: string, places: string[]): DeploymentNode {
  return {
    id, name: id.toUpperCase(), description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    version: 1, created_at: "", updated_at: "",
    sites: places.map((sid) => ({ id: sid, name: sid, kind: "vm" as const, partial: false })),
    instances: places,
  };
}
// Узел поддерева с родителем: контейнер (kids > 0) или лист.
function tnode(id: string, parent: string | null, places: string[] = [], kids = 0): DeploymentNode {
  return { ...obj(id, places), parent_id: parent, has_children: kids > 0, child_count: kids };
}
function graph(sites: SiteOut[], nodes: DeploymentNode[], edges: [string, string, string][] = []): DeploymentGraph {
  return {
    sites, nodes,
    edges: edges.map(([id, source_id, target_id]) => ({ id, label: id, technology: null, source_id, target_id, version: 1 })),
    layout: {}, version: 0, graph_rev: 0, meta_rev: 0,
  };
}
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("projectDeployment", () => {
  it("вложенность: корневые площадки — узлы уровня, вложенные и экземпляры — в children", () => {
    const p = projectDeployment(graph(
      [site("cloud", null, "cloud", "AWS"), site("k8s", "cloud"), site("vm")],
      [obj("a", ["k8s"]), obj("b", ["cloud"]), obj("c", ["vm"])],
    ));
    expect(ids(p.nodes)).toEqual([siteKey("cloud"), siteKey("vm")]);
    expect(ids(p.children[siteKey("cloud")])).toEqual([siteKey("k8s"), instanceKey("b", "cloud")]);
    expect(ids(p.children[siteKey("k8s")])).toEqual([instanceKey("a", "k8s")]);
    // имя площадки — текст плашки «Имя · технология»; родитель — ключ площадки
    const cloud = p.nodes[0];
    expect(cloud.name).toBe("cloud · AWS");
    expect(cloud.has_children).toBe(true);
    expect(cloud.child_count).toBe(2);
    expect(p.children[siteKey("cloud")][0].parent_id).toBe(siteKey("cloud"));
    // карточка экземпляра несёт поля объекта и пустой состав
    const a = p.children[siteKey("k8s")][0];
    expect(a.name).toBe("A");
    expect(a.parent_id).toBe(siteKey("k8s"));
    expect(a.has_children).toBe(false);
    // декор: площадки с иконкой вида сворачиваются
    expect(p.frameDecor(siteKey("cloud"))).toEqual({ kind: "site", icon: "cloud", collapsible: true, count: 2 });
    expect(p.frameDecor(siteKey("k8s"))).toMatchObject({ count: 1 });
    expect(p.frameDecor("not-a-site")).toBeUndefined();
  });

  it("объект на двух площадках в разных ветках — две карточки с пометками 1/2 и 2/2", () => {
    const p = projectDeployment(graph([site("s1"), site("t")], [obj("a", ["s1", "t"]), obj("b", ["t"])]));
    expect(p.marks).toEqual({ [instanceKey("a", "s1")]: "1/2", [instanceKey("a", "t")]: "2/2" });
    expect(p.groupOf(instanceKey("a", "t"))).toBe("a");
    expect(p.groupOf(siteKey("t"))).toBeUndefined();
    expect(p.siteOf.get(instanceKey("a", "s1"))).toEqual({ nodeId: "a", siteId: "s1" });
  });

  it("группа «Размещение не указано» — есть, когда есть объекты без размещения", () => {
    const p = projectDeployment(graph([site("s1")], [obj("a", []), obj("b", ["s1"])]));
    const group = p.nodes.find((n) => n.id === siteKey(UNPLACED))!;
    expect(group.name).toBe(UNPLACED_NAME);
    expect(ids(p.children[siteKey(UNPLACED)])).toEqual([instanceKey("a", UNPLACED)]);
    expect(p.frameDecor(siteKey(UNPLACED))).toEqual({ kind: "group", collapsible: false });
    expect(p.siteOf.get(instanceKey("a", UNPLACED))).toEqual({ nodeId: "a", siteId: UNPLACED });
  });

  it("группы «не указано» нет, когда размещены все", () => {
    const p = projectDeployment(graph([site("s1")], [obj("a", ["s1"])]));
    expect(p.nodes.some((n) => n.id === siteKey(UNPLACED))).toBe(false);
    expect(p.children[siteKey(UNPLACED)]).toBeUndefined();
  });

  it("пустая площадка — карточка без рамки: без детей, без пометок", () => {
    const p = projectDeployment(graph([site("empty"), site("s1")], [obj("a", ["s1"])]));
    const empty = p.nodes.find((n) => n.id === siteKey("empty"))!;
    expect(empty.has_children).toBe(false);
    expect(empty.child_count).toBe(0);
    expect(p.children[siteKey("empty")]).toBeUndefined();
    expect(p.marks[siteKey("empty")]).toBeUndefined();
  });

  it("ближайшие экземпляры: та же площадка", () => {
    const p = projectDeployment(graph(
      [site("s1"), site("t")], [obj("a", ["s1", "t"]), obj("b", ["s1", "t"])], [["e", "a", "b"]],
    ));
    expect(p.edges.map((e) => `${e.source_id}>${e.target_id}`)).toEqual([
      `${instanceKey("a", "s1")}>${instanceKey("b", "s1")}`,
      `${instanceKey("a", "t")}>${instanceKey("b", "t")}`,
    ]);
    expect(p.edges.map((e) => e.id)).toEqual(["deploy:e@s1@s1", "deploy:e@t@t"]);
    expect(p.edges[0].label).toBe("e");
  });

  it("ближайшие экземпляры: общий предок ближе, чем его отсутствие", () => {
    const p = projectDeployment(graph(
      [site("root"), site("s2", "root"), site("s3", "root"), site("t")],
      [obj("a", ["s2"]), obj("b", ["t", "s3"])], [["e", "a", "b"]],
    ));
    expect(p.edges.map((e) => `${e.source_id}>${e.target_id}`)).toEqual([
      `${instanceKey("a", "s2")}>${instanceKey("b", "s3")}`,
    ]);
  });

  it("ближайшие экземпляры: длиннее общая цепочка площадок — ближе (машина той же группы, не соседней)", () => {
    const p = projectDeployment(graph(
      [site("dc"), site("g1", "dc"), site("g2", "dc"), site("v11", "g1"), site("v12", "g1"), site("v21", "g2"), site("v22", "g2")],
      [obj("a", ["v11", "v21"]), obj("b", ["v12", "v22"])], [["e", "a", "b"]],
    ));
    expect(p.edges.map((e) => `${e.source_id}>${e.target_id}`)).toEqual([
      `${instanceKey("a", "v11")}>${instanceKey("b", "v12")}`,
      `${instanceKey("a", "v21")}>${instanceKey("b", "v22")}`,
    ]);
  });

  it("равноудалённые экземпляры цели — стрелка к каждому (соседние группы одного ЦОД)", () => {
    const p = projectDeployment(graph(
      [site("dc"), site("g1", "dc"), site("g2", "dc"), site("g3", "dc"), site("v11", "g1"), site("v21", "g2"), site("v31", "g3")],
      [obj("a", ["v31"]), obj("b", ["v11", "v21"])], [["e", "a", "b"]],
    ));
    expect(p.edges.map((e) => `${e.id}:${e.source_id}>${e.target_id}`)).toEqual([
      `deploy:e@v31@v11:${instanceKey("a", "v31")}>${instanceKey("b", "v11")}`,
      `deploy:e@v31@v21:${instanceKey("a", "v31")}>${instanceKey("b", "v21")}`,
    ]);
  });

  it("та же площадка ближе вложенной в неё", () => {
    const p = projectDeployment(graph(
      [site("k8s"), site("ns", "k8s")],
      [obj("a", ["k8s"]), obj("b", ["ns", "k8s"])], [["e", "a", "b"]],
    ));
    expect(p.edges.map((e) => `${e.source_id}>${e.target_id}`)).toEqual([
      `${instanceKey("a", "k8s")}>${instanceKey("b", "k8s")}`,
    ]);
  });

  it("цельный контейнер на одной площадке — одна карточка, бейдж — число объектов внутри", () => {
    const p = projectDeployment(graph([site("s1")], [
      tnode("c", null, ["s1"], 2),
      tnode("l1", "c", ["s1"]),
      tnode("sub", "c", ["s1"], 2),
      tnode("l2", "sub", ["s1"]),
      tnode("l3", "sub", ["s1"]),
    ]));
    expect(ids(p.children[siteKey("s1")])).toEqual([instanceKey("c", "s1")]);
    const card = p.children[siteKey("s1")][0];
    expect(card.name).toBe("C");
    expect(card.has_children).toBe(true);
    expect(card.child_count).toBe(3);
    expect(p.marks).toEqual({});
    expect(p.groupOf(card.id)).toBe("c");
    expect(p.siteOf.get(card.id)).toEqual({ nodeId: "c", siteId: "s1" });
    // контейнер не раскрывается: в карте состава его нет
    expect(p.children[card.id]).toBeUndefined();
  });

  it("цельный контейнер на двух площадках — две карточки с пометками 1/2 и 2/2", () => {
    const p = projectDeployment(graph([site("s1"), site("t")], [
      tnode("c", null, ["s1", "t"], 2),
      tnode("l1", "c", ["s1", "t"]),
      tnode("l2", "c", ["t", "s1"]),
    ]));
    expect(ids(p.children[siteKey("s1")])).toEqual([instanceKey("c", "s1")]);
    expect(ids(p.children[siteKey("t")])).toEqual([instanceKey("c", "t")]);
    expect(p.marks).toEqual({ [instanceKey("c", "s1")]: "1/2", [instanceKey("c", "t")]: "2/2" });
  });

  it("цельный контейнер без размещения — одна карточка в группе «не указано»", () => {
    const p = projectDeployment(graph([site("s1")], [
      tnode("c", null, [], 2), tnode("l1", "c"), tnode("l2", "c"),
    ]));
    expect(ids(p.children[siteKey(UNPLACED)])).toEqual([instanceKey("c", UNPLACED)]);
    expect(p.children[siteKey(UNPLACED)][0].child_count).toBe(2);
  });

  it("рассыпанный контейнер — объекты по отдельности, вложенный цельный — карточка", () => {
    const p = projectDeployment(graph([site("s1"), site("t")], [
      tnode("c", null, [], 2),
      tnode("l1", "c", ["s1"]),
      tnode("sub", "c", ["t"], 2),
      tnode("l2", "sub", ["t"]),
      tnode("l3", "sub", ["t"]),
    ]));
    expect(ids(p.children[siteKey("s1")])).toEqual([instanceKey("l1", "s1")]);
    expect(ids(p.children[siteKey("t")])).toEqual([instanceKey("sub", "t")]);
    expect(p.children[siteKey("t")][0].child_count).toBe(2);
    expect(p.siteOf.has(instanceKey("c", "s1"))).toBe(false);
  });

  it("контейнер без листьев в ответе (внутри одни «Пользователи») не рисуется", () => {
    const p = projectDeployment(graph([site("s1")], [tnode("c", null, ["s1"], 1), tnode("x", null, ["s1"])]));
    expect(ids(p.children[siteKey("s1")])).toEqual([instanceKey("x", "s1")]);
  });

  it("связи поднимаются к представителям: внутри цельного — скрыта, наружу — от карточки контейнера", () => {
    const p = projectDeployment(graph([site("s1"), site("t")], [
      tnode("c", null, ["s1"], 2),
      tnode("l1", "c", ["s1"]),
      tnode("l2", "c", ["s1"]),
      tnode("x", null, ["t"]),
    ], [["in", "l1", "l2"], ["out", "l1", "x"], ["own", "c", "x"]]));
    expect(p.edges.map((e) => `${e.id}:${e.source_id}>${e.target_id}`)).toEqual([
      `deploy:out@s1@t:${instanceKey("c", "s1")}>${instanceKey("x", "t")}`,
      `deploy:own@s1@t:${instanceKey("c", "s1")}>${instanceKey("x", "t")}`,
    ]);
  });

  it("связь с концом-рассыпанным контейнером не рисуется — у него нет представителя", () => {
    const p = projectDeployment(graph([site("s1"), site("t")], [
      tnode("c", null, [], 2),
      tnode("l1", "c", ["s1"]),
      tnode("l2", "c", ["t"]),
      tnode("x", null, ["t"]),
    ], [["e", "c", "x"], ["f", "l2", "x"]]));
    expect(p.edges.map((e) => e.id)).toEqual(["deploy:f@t@t"]);
  });

  it("реестр концов: у каждой карточки цепочка площадок от корневой, у «не указано» — группа", () => {
    const p = projectDeployment(graph(
      [site("cloud", null, "cloud"), site("k8s", "cloud"), site("ns", "k8s")],
      [obj("a", ["ns"]), obj("b", ["cloud", "k8s"]), obj("u", [])],
    ));
    const chain = (id: string) => p.endpoints.find((e) => e.id === id)?.ancestors.map((a) => a.id);
    expect(chain(instanceKey("a", "ns"))).toEqual([siteKey("cloud"), siteKey("k8s"), siteKey("ns")]);
    expect(chain(instanceKey("b", "cloud"))).toEqual([siteKey("cloud")]);
    expect(chain(instanceKey("b", "k8s"))).toEqual([siteKey("cloud"), siteKey("k8s")]);
    expect(chain(instanceKey("u", UNPLACED))).toEqual([siteKey(UNPLACED)]);
    const a = p.endpoints.find((e) => e.id === instanceKey("a", "ns"))!;
    expect(a).toMatchObject({ name: "A", shape: "service", node_depth: 3, has_children: false, is_ghost: true });
    expect(p.endpoints).toHaveLength(4);
  });

  it("без общих предков все экземпляры цели равны — стрелка к каждому; от «не указано» — ко всем", () => {
    const p = projectDeployment(graph(
      [site("s1"), site("u"), site("t")],
      [obj("a", ["t"]), obj("b", ["s1", "u"]), obj("c", [])],
      [["e1", "a", "b"], ["e2", "c", "b"], ["e3", "b", "c"]],
    ));
    expect(p.edges.map((e) => `${e.id}:${e.source_id}>${e.target_id}`)).toEqual([
      `deploy:e1@t@s1:${instanceKey("a", "t")}>${instanceKey("b", "s1")}`,
      `deploy:e1@t@u:${instanceKey("a", "t")}>${instanceKey("b", "u")}`,
      `deploy:e2@${UNPLACED}@s1:${instanceKey("c", UNPLACED)}>${instanceKey("b", "s1")}`,
      `deploy:e2@${UNPLACED}@u:${instanceKey("c", UNPLACED)}>${instanceKey("b", "u")}`,
      `deploy:e3@s1@${UNPLACED}:${instanceKey("b", "s1")}>${instanceKey("c", UNPLACED)}`,
      `deploy:e3@u@${UNPLACED}:${instanceKey("b", "u")}>${instanceKey("c", UNPLACED)}`,
    ]);
  });
});

// Проекция на настоящем конвейере: подъём конца связи к карточке свёрнутой площадки
// (реестр концов + liftEdgesToLevel), без гостей.
describe("проекция + конвейер: свёрнутая площадка", () => {
  const g = graph(
    [site("cloud", null, "cloud"), site("k8s", "cloud"), site("vm", null, "vm")],
    [obj("a", ["k8s"]), obj("b", ["k8s"]), obj("x", ["vm"])],
    [["ax", "a", "x"], ["ab", "a", "b"]],
  );
  const run = (collapsed: string[]) => {
    const p = projectDeployment(g);
    const expanded = new Set(Object.keys(p.children).filter((k) => !collapsed.includes(k)));
    return computeViewLayout({
      nodes: p.nodes, endpoints: p.endpoints, edges: p.edges, containerId: null, viewLayout: {},
      ancestorIds: [], expanded, localChildren: p.children, maxInlineDepth: Infinity, edgeQuality: "full",
    });
  };
  const ends = (out: Awaited<ReturnType<typeof run>>) =>
    out.layout.groupArr.map((x) => `${x.source}>${x.target}`).sort();

  it("раскрыто: связи между карточками объектов", async () => {
    const out = await run([]);
    expect(ends(out)).toEqual([
      `${instanceKey("a", "k8s")}>${instanceKey("b", "k8s")}`,
      `${instanceKey("a", "k8s")}>${instanceKey("x", "vm")}`,
    ].sort());
    expect(out.layout.entities).toEqual([]);
  });

  it("свёрнут кластер: связь наружу упирается в его карточку, внутренняя пропадает", async () => {
    const out = await run([siteKey("k8s")]);
    expect(ends(out)).toEqual([`${siteKey("k8s")}>${instanceKey("x", "vm")}`]);
    expect(out.layout.nodes.map((n) => n.id)).toContain(siteKey("k8s"));
    expect(out.layout.entities).toEqual([]);
  });

  it("свёрнуто облако: конец поднимается к ближайшей отображаемой площадке — корневой", async () => {
    const out = await run([siteKey("cloud")]);
    expect(ends(out)).toEqual([`${siteKey("cloud")}>${instanceKey("x", "vm")}`]);
    expect(out.layout.entities).toEqual([]);
  });
});

// Глубина цвета карточки (D9): число предков узла в дереве объектов — у корней объёма
// глубина уровня, вложенность площадок не считается.
describe("depths", () => {
  it("корни объёма — глубина уровня, дети рассыпанного контейнера — глубже; площадки не считаются", () => {
    const p = projectDeployment(graph(
      [site("cloud", null, "cloud"), site("k8s", "cloud"), site("ns", "k8s")],
      [
        obj("a", ["ns"]),
        tnode("c", null, [], 2), tnode("l1", "c", ["cloud"]), tnode("sub", "c", ["k8s"], 1), tnode("l2", "sub", ["k8s"]),
      ],
    ), 1);
    expect(p.depths).toEqual({
      [instanceKey("a", "ns")]: 1,
      [instanceKey("l1", "cloud")]: 2,
      // вложенный цельный подконтейнер — карточка с глубиной самого подконтейнера
      [instanceKey("sub", "k8s")]: 2,
    });
  });

  it("по умолчанию уровень — весь проект: глубина корней 0; у каждой карточки объекта на двух площадках — одна", () => {
    const p = projectDeployment(graph([site("s1"), site("t")], [obj("a", ["s1", "t"]), obj("u", [])]));
    expect(p.depths).toEqual({
      [instanceKey("a", "s1")]: 0, [instanceKey("a", "t")]: 0, [instanceKey("u", UNPLACED)]: 0,
    });
  });
});

// Ф6: запросы к проекции из режима размещения и дерева (deployment.md D28–D29).
describe("cardsOf и pickedSite", () => {
  const g = () => projectDeployment(graph([site("s1"), site("t", "s1")], [
    obj("a", ["s1", "t"]), obj("b", []),
    tnode("c", null, ["t"], 1), tnode("l", "c", ["t"]),
  ]));

  it("cardsOf: карточки представителя в порядке размещения; не представитель — пусто", () => {
    const p = g();
    expect(cardsOf(p, "a")).toEqual([instanceKey("a", "s1"), instanceKey("a", "t")]);
    expect(cardsOf(p, "c")).toEqual([instanceKey("c", "t")]);
    // лист внутри цельного контейнера на этом уровне не рисуется
    expect(cardsOf(p, "l")).toEqual([]);
  });

  it("pickedSite: рамка и карточка площадки — она сама, карточка объекта — её площадка, «не указано» — ничего", () => {
    const p = g();
    expect(pickedSite(p, siteKey("t"))).toBe("t");
    expect(pickedSite(p, instanceKey("a", "s1"))).toBe("s1");
    expect(pickedSite(p, siteKey(UNPLACED))).toBeNull();
    expect(pickedSite(p, instanceKey("b", UNPLACED))).toBeNull();
    expect(pickedSite(p, "чужой-id")).toBeNull();
  });
});
