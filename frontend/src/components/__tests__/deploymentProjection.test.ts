// Проекция графа развёртывания на холст (docs/specs/deployment.md): вложенность
// площадок, экземпляры с пометками «i/n», группа «Размещение не указано», правило
// ближайшего экземпляра для связей, пустая площадка карточкой.
import { describe, it, expect } from "vitest";
import {
  projectDeployment, siteKey, instanceKey, UNPLACED, UNPLACED_NAME,
} from "../deployment/deploymentProjection";
import type { DeploymentGraph, DeploymentNode, SiteKind, SiteOut } from "../../types";

function site(id: string, parent_id: string | null = null, kind: SiteKind = "kubernetes", technology: string | null = null): SiteOut {
  return { id, name: id, kind, technology, description: null, parent_id, version: 1, instance_count: 0 };
}
function obj(id: string, places: string[], inheritedFrom: string | null = null): DeploymentNode {
  return {
    id, name: id.toUpperCase(), description: null, role: null, technology: null, parent_id: null,
    openapi_spec: null, docs: [], is_external: false, shape: "service", status: "existing",
    child_count: 0, has_children: false, approval: "in_progress", approval_effective: "in_progress",
    sites: [], version: 1, created_at: "", updated_at: "",
    instances: inheritedFrom ? [] : places,
    effective: places.map((site_id) => ({ site_id, inherited_from_id: inheritedFrom })),
  };
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
    expect(p.frameDecor(siteKey("cloud"))).toEqual({ kind: "site", icon: "cloud", collapsible: true });
    expect(p.frameDecor("not-a-site")).toBeUndefined();
  });

  it("объект на двух площадках в разных ветках — две карточки с пометками 1/2 и 2/2", () => {
    const p = projectDeployment(graph([site("s1"), site("t")], [obj("a", ["s1", "t"]), obj("b", ["t"])]));
    expect(p.marks).toEqual({ [instanceKey("a", "s1")]: "1/2", [instanceKey("a", "t")]: "2/2" });
    expect(p.groupOf(instanceKey("a", "t"))).toBe("a");
    expect(p.groupOf(siteKey("t"))).toBeUndefined();
    expect(p.siteOf.get(instanceKey("a", "s1"))).toEqual({ nodeId: "a", siteId: "s1" });
  });

  it("унаследованное размещение рисуется так же, как своё", () => {
    const p = projectDeployment(graph([site("s1")], [obj("a", ["s1"], "parent")]));
    expect(ids(p.children[siteKey("s1")])).toEqual([instanceKey("a", "s1")]);
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

  it("ближайший экземпляр: та же площадка", () => {
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

  it("ближайший экземпляр: та же корневая площадка", () => {
    const p = projectDeployment(graph(
      [site("root"), site("s2", "root"), site("s3", "root"), site("t")],
      [obj("a", ["s2"]), obj("b", ["t", "s3"])], [["e", "a", "b"]],
    ));
    expect(p.edges.map((e) => `${e.source_id}>${e.target_id}`)).toEqual([
      `${instanceKey("a", "s2")}>${instanceKey("b", "s3")}`,
    ]);
  });

  it("ближайший экземпляр: иначе первый экземпляр цели; «не указано» — по тому же правилу", () => {
    const p = projectDeployment(graph(
      [site("s1"), site("u"), site("t")],
      [obj("a", ["t"]), obj("b", ["s1", "u"]), obj("c", [])],
      [["e1", "a", "b"], ["e2", "c", "b"], ["e3", "b", "c"]],
    ));
    expect(p.edges.map((e) => `${e.id}:${e.source_id}>${e.target_id}`)).toEqual([
      `deploy:e1@t@s1:${instanceKey("a", "t")}>${instanceKey("b", "s1")}`,
      `deploy:e2@${UNPLACED}@s1:${instanceKey("c", UNPLACED)}>${instanceKey("b", "s1")}`,
      `deploy:e3@s1@${UNPLACED}:${instanceKey("b", "s1")}>${instanceKey("c", UNPLACED)}`,
      `deploy:e3@u@${UNPLACED}:${instanceKey("b", "u")}>${instanceKey("c", UNPLACED)}`,
    ]);
  });
});
