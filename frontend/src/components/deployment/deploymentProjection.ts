// ПРОЕКЦИЯ ГРАФА РАЗВЁРТЫВАНИЯ НА ХОЛСТ (docs/specs/deployment.md). Чистая функция:
// ответ GET /deployment/graph → вход LevelGraph с бандлом projection.
//
// Граф отдаёт ВСЁ поддерево уровня, холст рисует ПРЕДСТАВИТЕЛЕЙ (D22, D33). Единица
// размещения — контейнер (element_effective от сервера: лист вне контейнера или контейнер
// с компонентами; Р16 эпика docs/plan-c4-elements.md) — всегда свой представитель: одна
// сплошная карточка в каждой площадке своего размещения, без бейджа; вниз проекция не
// спускается, компоненты не рисуются, а концы их связей поднимаются к контейнеру.
// Система ЦЕЛЬНАЯ, если у всех её единиц одинаковый набор площадок («не указано» — тоже
// набор): тогда она одна пунктирная карточка в каждой площадке набора с бейджем числа
// единиц, а её содержимое не рисуется. Иначе система рассыпается до детей, и правило
// повторяется на них сверху вниз. Система без единиц в ответе (внутри одни
// «Пользователи») не рисуется. Системы на этом холсте НЕ раскрываются: двойной клик по
// карточке системы — вход в её уровень, по карточке единицы — страница объекта.
//
// Площадки — раскрываемые ЛОКАЛЬНЫЕ контейнеры уровня (R5): корневые площадки — узлы
// уровня, вложенные площадки и карточки — их дети (children). Площадка по умолчанию
// раскрыта и сворачивается в карточку площадки (состояние вида, D2, D21); пустая на
// уровне площадка — та же карточка. Карточка представителя — блок
// `deploy:<узел>@<площадка>` в рамке каждой площадки его действующего размещения, с
// пометкой «i/n» при n > 1. Без размещения — в пунктирной группе «Размещение не указано»
// (`deploy:site:unplaced`).
//
// Связи — сырые связи поддерева, поднятые к представителям (связь внутри одного
// представителя не рисуется, конец без представителя — тоже), затем по правилу
// БЛИЖАЙШИХ экземпляров (D11): от каждого экземпляра источника — стрелка к каждому из
// ближайших экземпляров цели. Ближе тот, у чьей площадки длиннее общая с площадкой
// источника цепочка предков (та же площадка — ближе всего); равноудалённые — все, в том
// числе когда общих предков нет ни у кого (объект без размещения — ко всем экземплярам
// цели, порядок — instances). Реестр концов (endpoints) — цепочка площадок над
// каждой карточкой: у свёрнутой площадки конец связи поднимается к её карточке штатным
// подъёмом конвейера (liftEdgesToLevel, D23).
import type {
  AncestorRef, DeploymentGraph, DeploymentNode, Edge as AppEdge, GhostNode, Node as AppNode, SiteOut,
} from "../../types";
import type { FrameDecor } from "../graph/types";

/** «Площадка» объектов без размещения: группа холста и хвост ключей их карточек. */
export const UNPLACED = "unplaced";
export const UNPLACED_NAME = "Размещение не указано";

/** Ключ рамки (и карточки) площадки в раскладке вида. */
export const siteKey = (siteId: string): string => `deploy:site:${siteId}`;
/** Ключ карточки «представитель на площадке» в раскладке вида. */
export const instanceKey = (nodeId: string, siteId: string): string => `deploy:${nodeId}@${siteId}`;

/** Карточки узла на холсте уровня — в порядке его действующего размещения. Пусто, если
 *  узел на этом уровне не представитель (его рисует цельная система, компонента нет на
 *  холсте вовсе) или вне объёма. */
export function cardsOf(proj: Pick<DeploymentProjection, "siteOf">, nodeId: string): string[] {
  const out: string[] = [];
  for (const [cardId, inst] of proj.siteOf) if (inst.nodeId === nodeId) out.push(cardId);
  return out;
}

/** Площадка, выбранная щелчком в режиме размещения (deployment.md D29): рамка или
 *  карточка площадки — она сама, карточка объекта — площадка, на которой она стоит.
 *  Группа «не указано» (и её карточки) площадкой не является — null. */
export function pickedSite(proj: Pick<DeploymentProjection, "siteOf">, canvasId: string): string | null {
  const prefix = siteKey("");
  const siteId = canvasId.startsWith(prefix) ? canvasId.slice(prefix.length) : proj.siteOf.get(canvasId)?.siteId;
  return siteId && siteId !== UNPLACED ? siteId : null;
}

export interface DeploymentProjection {
  // узлы уровня: корневые площадки и группа «не указано» (если она есть)
  nodes: AppNode[];
  // полный состав раскрываемых контейнеров: площадка → вложенные площадки и карточки
  children: Record<string, AppNode[]>;
  // связи между карточками представителей (правило ближайших экземпляров, D11)
  edges: AppEdge[];
  // реестр концов: каждая карточка с цепочкой площадок над ней (корневая — первой)
  endpoints: GhostNode[];
  // пометка «i/n» у карточек представителя, стоящего на нескольких площадках
  marks: Record<string, string>;
  // декор рамки: площадка — с иконкой вида, сворачивается (число объектов — для её
  // карточки); группа «не указано» — пунктир, не сворачивается
  frameDecor: (frameId: string) => FrameDecor | undefined;
  // узел карточки (близнецы — карточки одного представителя); у площадок — undefined
  groupOf: (id: string) => string | undefined;
  // карточка → её узел и площадка (UNPLACED у группы «не указано»)
  siteOf: Map<string, { nodeId: string; siteId: string }>;
  // глубина цвета карточки — архитектурная глубина её узла (число предков в дереве
  // объектов), как на холсте объектов; вложенность площадок на цвет не влияет
  depths: Record<string, number>;
}

// Представитель: единица (контейнер) или цельная система, её площадки и число единиц
// внутри — у единицы 1.
interface Rep {
  node: DeploymentNode;
  places: string[];
  units: number;
  system: boolean;
}

// Набор площадок поддерева: общий у всех его единиц (places — в порядке первой
// единицы), «mixed» — у единиц разные наборы, «empty» — единиц в ответе нет.
type Uniform = { places: string[]; units: number } | "mixed" | "empty";

// Ключ набора площадок: множество id, порядок не важен.
const setKey = (places: string[]): string => [...places].sort().join("|");

// Узел-площадка (контейнер холста). Имя — текст плашки рамки и карточки: «Имя ·
// технология».
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
    // Площадка — не объект архитектуры: элемента у её карточки нет.
    element: null,
    element_effective: null,
    sites: [],
    version: site.version,
    created_at: "",
    updated_at: "",
  };
}

// Карточка представителя: поля узла (имя, форма, статус, внешность…) под ключом
// карточки. У цельной системы — признак детей и число единиц внутри (пунктир и бейдж);
// раскрывать её холст не станет — в карте состава её нет. У единицы — карточка
// объекта: сплошная, без бейджа и лупы, и у контейнера с компонентами (Р17).
function repCard(rep: Rep, siteId: string): AppNode {
  return {
    ...rep.node,
    id: instanceKey(rep.node.id, siteId),
    parent_id: siteKey(siteId),
    has_children: rep.system,
    child_count: rep.system ? rep.units : 0,
    docs: [],
  };
}

/** Проекция графа уровня на холст. levelDepth — число предков у корней объёма (прямых
 *  детей системы уровня; 0 у всего проекта): от него считается глубина цвета карточек. */
export function projectDeployment(graph: DeploymentGraph, levelDepth = 0): DeploymentProjection {
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

  // Дерево узлов ответа: дети по родителю в порядке ответа (по имени); узел, чей
  // родитель вне ответа, — корень объёма уровня.
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const order = new Map(graph.nodes.map((n, i) => [n.id, i] as const));
  const kidsOf = new Map<string, DeploymentNode[]>();
  const roots: DeploymentNode[] = [];
  for (const n of graph.nodes) {
    if (n.parent_id && nodeById.has(n.parent_id)) {
      const list = kidsOf.get(n.parent_id);
      if (list) list.push(n);
      else kidsOf.set(n.parent_id, [n]);
    } else {
      roots.push(n);
    }
  }
  // Лист — узел без детей вообще: has_children сервер считает по всем прямым детям, и
  // система, внутри которой одни «Пользователи», листом не становится.
  const isLeaf = (n: DeploymentNode): boolean => !n.has_children && !kidsOf.has(n.id);
  // Единица размещения (D33) — контейнер: лист вне контейнера или контейнер с
  // компонентами. Элемент считает сервер; компонент единицей не бывает и листом.
  const isComponent = (n: DeploymentNode): boolean => n.element_effective === "component";
  const isUnit = (n: DeploymentNode): boolean =>
    !isComponent(n) && (n.element_effective === "container" || isLeaf(n));

  // Площадки единицы в порядке ответа (неизвестные отброшены); без площадок — группа
  // «не указано». Размещение хранится у единиц: система — производное от них.
  const unitPlaces = (n: DeploymentNode): string[] => {
    const places = n.instances.filter((id) => siteById.has(id));
    return places.length > 0 ? [...new Set(places)] : [UNPLACED];
  };

  // Набор площадок поддерева — снизу вверх с памятью. Обход идёт только вниз от корней:
  // узел, достижимый от корня, в цикл родителей входить не может (у каждого узла один
  // родитель), поэтому seen здесь не нужен.
  const memo = new Map<string, Uniform>();
  const uniformOf = (n: DeploymentNode): Uniform => {
    const hit = memo.get(n.id);
    if (hit) return hit;
    let res: Uniform = "empty";
    if (isComponent(n)) {
      // компонент не размещается и не рисуется: его площадки — у контейнера
    } else if (isUnit(n)) {
      res = { places: unitPlaces(n), units: 1 };
    } else {
      for (const k of kidsOf.get(n.id) ?? []) {
        const u = uniformOf(k);
        if (u === "empty") continue;
        if (u === "mixed") { res = "mixed"; break; }
        if (res === "empty") res = { places: u.places, units: u.units };
        else if (setKey(res.places) === setKey(u.places)) res = { places: res.places, units: res.units + u.units };
        else { res = "mixed"; break; }
      }
    }
    memo.set(n.id, res);
    return res;
  };

  // Представители сверху вниз: единица и цельная система — представитель (вниз не
  // спускаемся), рассыпанная система — к детям, пустой узел и компонент — пропуск.
  // Порядок — порядок ответа (по имени): от него зависит порядок карточек в рамке.
  const reps: Rep[] = [];
  const walk = (n: DeploymentNode): void => {
    const u = uniformOf(n);
    if (u === "empty") return;
    if (u === "mixed") {
      for (const k of kidsOf.get(n.id) ?? []) walk(k);
      return;
    }
    reps.push({ node: n, places: u.places, units: u.units, system: !isUnit(n) });
  };
  for (const r of roots) walk(r);
  reps.sort((a, b) => (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0));
  const repById = new Map(reps.map((r) => [r.node.id, r] as const));

  // Архитектурная глубина узла: у корня объёма — глубина уровня, у ребёнка — на один
  // больше (подъём по parent_id в пределах ответа, с seen на случай цикла в данных).
  const depthMemo = new Map<string, number>();
  const depthOf = (id: string): number => {
    const hit = depthMemo.get(id);
    if (hit !== undefined) return hit;
    let d = levelDepth;
    const seen = new Set<string>([id]);
    for (let p = nodeById.get(id)?.parent_id; p && nodeById.has(p) && !seen.has(p); p = nodeById.get(p)?.parent_id) {
      seen.add(p);
      d++;
    }
    depthMemo.set(id, d);
    return d;
  };

  // Карточки по площадкам + пометки + обратная карта + глубина цвета.
  const cardsBySite = new Map<string, AppNode[]>();
  const marks: Record<string, string> = {};
  const depths: Record<string, number> = {};
  const siteOf = new Map<string, { nodeId: string; siteId: string }>();
  for (const rep of reps) {
    rep.places.forEach((siteId, i) => {
      const card = repCard(rep, siteId);
      const list = cardsBySite.get(siteId);
      if (list) list.push(card);
      else cardsBySite.set(siteId, [card]);
      siteOf.set(card.id, { nodeId: rep.node.id, siteId });
      depths[card.id] = depthOf(rep.node.id);
      if (rep.places.length > 1) marks[card.id] = `${i + 1}/${rep.places.length}`;
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

  // Узлы площадок сверху вниз; состав раскрываемых — в children, цепочка ключей
  // площадок от корневой — в chainOf (реестр концов), число карточек на площадке и во
  // вложенных — в countOf (карточка свёрнутой площадки). Пустая площадка остаётся
  // карточкой площадки (has_children: false) и в children не попадает.
  const children: Record<string, AppNode[]> = {};
  const chainOf = new Map<string, AncestorRef[]>();
  const countOf = new Map<string, number>();
  // Звено цепочки — площадка, а не объект: элемента архитектуры у неё нет.
  const siteRef = (site: SiteOut): AncestorRef => ({
    id: siteKey(site.id),
    name: site.technology ? `${site.name} · ${site.technology}` : site.name,
    is_external: false,
    element_effective: null,
  });
  const build = (site: SiteOut, parentKey: string | null, chain: AncestorRef[], seen: Set<string>): AppNode => {
    const nested = (childSites.get(site.id) ?? []).filter((c) => !seen.has(c.id));
    const nextSeen = new Set(seen).add(site.id);
    const ownChain = [...chain, siteRef(site)];
    chainOf.set(site.id, ownChain);
    const cards = cardsBySite.get(site.id) ?? [];
    const kids = [
      ...nested.map((c) => build(c, siteKey(site.id), ownChain, nextSeen)),
      ...cards,
    ];
    countOf.set(site.id, cards.length + nested.reduce((sum, c) => sum + (countOf.get(c.id) ?? 0), 0));
    if (kids.length > 0) children[siteKey(site.id)] = kids;
    return siteNode(site, parentKey, kids.length);
  };
  const nodes: AppNode[] = rootSites.map((s) => build(s, null, [], new Set()));

  // Группа «Размещение не указано» — только если в ней кто-то есть.
  const unplacedKey = siteKey(UNPLACED);
  const unplaced = cardsBySite.get(UNPLACED) ?? [];
  if (unplaced.length > 0) {
    nodes.push({
      ...siteNode(
        { id: UNPLACED, name: UNPLACED_NAME, kind: "other", version: 1, instance_count: 0 },
        null, unplaced.length,
      ),
      role: null,
    });
    children[unplacedKey] = unplaced;
    chainOf.set(UNPLACED, [{ id: unplacedKey, name: UNPLACED_NAME, is_external: false, element_effective: null }]);
  }

  // Реестр концов: каждая карточка — с цепочкой площадок над ней. Свёрнута площадка в
  // цепочке — конвейер поднимет конец связи к ближайшей ОТОБРАЖАЕМОЙ (её карточке);
  // корневая площадка отображается всегда, поэтому гостем конец не станет.
  const endpoints: GhostNode[] = [];
  for (const rep of reps) {
    for (const siteId of rep.places) {
      const ancestors = chainOf.get(siteId) ?? [];
      const n = rep.node;
      endpoints.push({
        id: instanceKey(n.id, siteId),
        name: n.name,
        role: n.role,
        technology: n.technology,
        is_external: n.is_external,
        shape: n.shape,
        status: n.status,
        node_depth: ancestors.length,
        has_children: rep.system,
        child_count: rep.system ? rep.units : 0,
        element_effective: n.element_effective,
        ancestors,
        is_ghost: true,
      });
    }
  }

  // Представитель конца связи: сам узел или ближайший предок-представитель — у
  // компонента это его контейнер или цельная система над ним (подъём с seen — данные
  // могут оказаться циклом). Нет такого — связь не рисуется.
  const repOf = (id: string): Rep | undefined => {
    const seen = new Set<string>();
    for (let cur: string | null | undefined = id; cur && !seen.has(cur); cur = nodeById.get(cur)?.parent_id) {
      const rep = repById.get(cur);
      if (rep) return rep;
      seen.add(cur);
    }
    return undefined;
  };

  // Близость площадки экземпляра цели к площадке экземпляра источника: та же площадка —
  // ближе всего, иначе — длина общей цепочки предков (от корневой; 0 — общих нет; у
  // «не указано» цепочка из одной группы, общей ни с одной площадкой).
  const chainIds = (siteId: string): string[] => (chainOf.get(siteId) ?? []).map((a) => a.id);
  const closeness = (s: string, t: string): number => {
    if (s === t) return Infinity;
    const a = chainIds(s);
    const b = chainIds(t);
    let n = 0;
    while (n < a.length && n < b.length && a[n] === b[n]) n++;
    return n;
  };
  // Ближайшие экземпляры цели — все с наибольшей близостью, в порядке размещения.
  const nearest = (s: string, places: string[]): string[] => {
    const best = Math.max(...places.map((t) => closeness(s, t)));
    return places.filter((t) => closeness(s, t) === best);
  };

  // Связи: подъём к представителям, затем правило ближайших экземпляров (D11).
  const edges: AppEdge[] = [];
  for (const e of graph.edges) {
    const src = repOf(e.source_id);
    const tgt = repOf(e.target_id);
    if (!src || !tgt || src === tgt) continue;
    for (const s of src.places) {
      for (const t of nearest(s, tgt.places)) {
        edges.push({
          id: `deploy:${e.id}@${s}@${t}`,
          label: e.label,
          technology: e.technology,
          channel: e.channel,
          source_id: instanceKey(src.node.id, s),
          target_id: instanceKey(tgt.node.id, t),
          version: e.version,
          created_at: "",
        });
      }
    }
  }

  const frameDecor = (frameId: string): FrameDecor | undefined => {
    if (frameId === unplacedKey) return { kind: "group", collapsible: false };
    if (!frameId.startsWith("deploy:site:")) return undefined;
    const siteId = frameId.slice("deploy:site:".length);
    const site = siteById.get(siteId);
    return site ? { kind: "site", icon: site.kind, collapsible: true, count: countOf.get(siteId) ?? 0 } : undefined;
  };
  const groupOf = (id: string): string | undefined => siteOf.get(id)?.nodeId;

  return { nodes, children, edges, endpoints, marks, frameDecor, groupOf, siteOf, depths };
}
