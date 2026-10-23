// ПРОЕКЦИЯ ГРАФА РАЗВЁРТЫВАНИЯ НА ХОЛСТ (docs/specs/deployment.md). Чистая функция:
// ответ GET /deployment/graph → вход LevelGraph с бандлом projection.
//
// Площадки — раскрытые ЛОКАЛЬНЫЕ контейнеры уровня (R5): корневые площадки — узлы
// уровня, вложенные площадки и экземпляры — их дети (children). Экземпляр — обычный
// блок `deploy:<объект>@<площадка>`: объект рисуется карточкой в каждой рамке, где у
// него действующий экземпляр, с пометкой «i/n» при n > 1. Объекты без действующего
// размещения — в пунктирной группе «Размещение не указано» (`deploy:site:unplaced`).
// Пустая площадка (ни экземпляров, ни вложенных) — обычная карточка: у контейнера без
// детей конвейер рамку не строит, рамкой она станет с первым экземпляром.
//
// Связи — по правилу БЛИЖАЙШЕГО экземпляра (D-инварианты спеки): от каждого экземпляра
// источника ровно одна стрелка к экземпляру цели — на той же площадке, иначе под той
// же корневой площадкой, иначе к первому экземпляру цели (порядок effective).
import type { DeploymentGraph, DeploymentNode, Edge as AppEdge, Node as AppNode, SiteOut } from "../../types";
import type { FrameDecor } from "../graph/types";

/** «Площадка» объектов без размещения: группа холста и хвост ключей их карточек. */
export const UNPLACED = "unplaced";
export const UNPLACED_NAME = "Размещение не указано";

/** Ключ рамки (и карточки) площадки в раскладке вида. */
export const siteKey = (siteId: string): string => `deploy:site:${siteId}`;
/** Ключ карточки экземпляра «объект на площадке» в раскладке вида. */
export const instanceKey = (nodeId: string, siteId: string): string => `deploy:${nodeId}@${siteId}`;

export interface DeploymentProjection {
  // узлы уровня: корневые площадки и группа «не указано» (если она есть)
  nodes: AppNode[];
  // полный состав раскрытых контейнеров: площадка → вложенные площадки и экземпляры
  children: Record<string, AppNode[]>;
  // связи между экземплярами (правило ближайшего экземпляра)
  edges: AppEdge[];
  // пометка «i/n» у карточек объекта, стоящего на нескольких площадках
  marks: Record<string, string>;
  // декор рамки: площадка — с иконкой вида, сворачивается; группа «не указано» —
  // пунктир, не сворачивается
  frameDecor: (frameId: string) => FrameDecor | undefined;
  // объект карточки (близнецы — карточки одного объекта); у площадок — undefined
  groupOf: (id: string) => string | undefined;
  // карточка экземпляра → её объект и площадка (UNPLACED у группы «не указано»)
  siteOf: Map<string, { nodeId: string; siteId: string }>;
}

// Узел-площадка (контейнер холста). Имя — текст плашки рамки: «Имя · технология»; от
// него же препятствие плашки для роутера (framePlaqueRect). Роль «площадка» видна
// только у пустой площадки-карточки — чтобы её не приняли за объект.
function siteNode(site: SiteOut, parentKey: string | null, childCount: number): AppNode {
  return {
    id: siteKey(site.id),
    name: site.technology ? `${site.name} · ${site.technology}` : site.name,
    description: site.description ?? null,
    role: "площадка",
    technology: null,
    parent_id: parentKey,
    openapi_spec: null,
    docs: [],
    is_external: false,
    shape: "service",
    status: "existing",
    child_count: childCount,
    has_children: childCount > 0,
    approval: "in_progress",
    approval_effective: "in_progress",
    sites: [],
    version: site.version,
    created_at: "",
    updated_at: "",
  };
}

// Карточка экземпляра: поля объекта (имя, форма, статус, внешность…) под id экземпляра.
function instanceNode(node: DeploymentNode, siteId: string): AppNode {
  return {
    ...node,
    id: instanceKey(node.id, siteId),
    parent_id: siteKey(siteId),
    has_children: false,
    child_count: 0,
    docs: [],
  };
}

export function projectDeployment(graph: DeploymentGraph): DeploymentProjection {
  // Граф отдаёт всё поддерево уровня; карточками пока остаются только листья (как до
  // Ф5), связи с концом-контейнером ниже отсеются сами — у контейнера нет площадок.
  const leaves = graph.nodes.filter((n) => !n.has_children);
  const siteById = new Map(graph.sites.map((s) => [s.id, s] as const));
  // Корневая площадка каждой площадки (обход с seen: данные могут оказаться циклом).
  const rootOf = (siteId: string): string => {
    const seen = new Set<string>();
    let cur = siteId;
    for (;;) {
      const parent = siteById.get(cur)?.parent_id;
      if (!parent || !siteById.has(parent) || seen.has(parent)) return cur;
      seen.add(cur);
      cur = parent;
    }
  };

  // Действующие площадки объекта в порядке effective (неизвестные отброшены);
  // без площадок — группа «не указано».
  const placesOf = new Map<string, string[]>();
  for (const n of leaves) {
    const places = n.effective.map((e) => e.site_id).filter((id) => siteById.has(id));
    placesOf.set(n.id, places.length > 0 ? [...new Set(places)] : [UNPLACED]);
  }

  // Экземпляры по площадкам + пометки + обратная карта.
  const instancesBySite = new Map<string, AppNode[]>();
  const marks: Record<string, string> = {};
  const siteOf = new Map<string, { nodeId: string; siteId: string }>();
  for (const n of leaves) {
    const places = placesOf.get(n.id) ?? [UNPLACED];
    places.forEach((siteId, i) => {
      const inst = instanceNode(n, siteId);
      const list = instancesBySite.get(siteId);
      if (list) list.push(inst);
      else instancesBySite.set(siteId, [inst]);
      siteOf.set(inst.id, { nodeId: n.id, siteId });
      if (places.length > 1) marks[inst.id] = `${i + 1}/${places.length}`;
    });
  }

  // Вложенные площадки по родителю (родитель вне списка — площадка корневая).
  const childSites = new Map<string, SiteOut[]>();
  const rootSites: SiteOut[] = [];
  for (const s of graph.sites) {
    if (s.parent_id && siteById.has(s.parent_id) && rootOf(s.id) !== s.id) {
      const list = childSites.get(s.parent_id);
      if (list) list.push(s);
      else childSites.set(s.parent_id, [s]);
    } else {
      rootSites.push(s);
    }
  }

  // Узлы площадок сверху вниз; состав раскрытых — в children. Пустая площадка
  // остаётся карточкой (has_children: false) и в children не попадает.
  const children: Record<string, AppNode[]> = {};
  const build = (site: SiteOut, parentKey: string | null, seen: Set<string>): AppNode => {
    const nested = (childSites.get(site.id) ?? []).filter((c) => !seen.has(c.id));
    const nextSeen = new Set(seen).add(site.id);
    const kids = [
      ...nested.map((c) => build(c, siteKey(site.id), nextSeen)),
      ...(instancesBySite.get(site.id) ?? []),
    ];
    if (kids.length > 0) children[siteKey(site.id)] = kids;
    return siteNode(site, parentKey, kids.length);
  };
  const nodes: AppNode[] = rootSites.map((s) => build(s, null, new Set()));

  // Группа «Размещение не указано» — только если в ней кто-то есть.
  const unplaced = instancesBySite.get(UNPLACED) ?? [];
  if (unplaced.length > 0) {
    const key = siteKey(UNPLACED);
    nodes.push({
      ...siteNode(
        { id: UNPLACED, name: UNPLACED_NAME, kind: "other", version: 1, instance_count: 0 },
        null, unplaced.length,
      ),
      role: null,
    });
    children[key] = unplaced;
  }

  // Связи по правилу ближайшего экземпляра.
  const edges: AppEdge[] = [];
  for (const e of graph.edges) {
    const srcPlaces = placesOf.get(e.source_id);
    const tgtPlaces = placesOf.get(e.target_id);
    if (!srcPlaces || !tgtPlaces) continue;
    for (const s of srcPlaces) {
      const t = tgtPlaces.includes(s)
        ? s
        : tgtPlaces.find((x) => x !== UNPLACED && s !== UNPLACED && rootOf(x) === rootOf(s)) ?? tgtPlaces[0];
      edges.push({
        id: `deploy:${e.id}@${s}@${t}`,
        label: e.label,
        technology: e.technology,
        channel: e.channel,
        source_id: instanceKey(e.source_id, s),
        target_id: instanceKey(e.target_id, t),
        version: e.version,
        created_at: "",
      });
    }
  }

  const unplacedKey = siteKey(UNPLACED);
  const frameDecor = (frameId: string): FrameDecor | undefined => {
    if (frameId === unplacedKey) return { kind: "group", collapsible: false };
    if (!frameId.startsWith("deploy:site:")) return undefined;
    const site = siteById.get(frameId.slice("deploy:site:".length));
    return site ? { kind: "site", icon: site.kind, collapsible: true } : undefined;
  };
  const groupOf = (id: string): string | undefined => siteOf.get(id)?.nodeId;

  return { nodes, children, edges, marks, frameDecor, groupOf, siteOf };
}
