// Реконструкция изломов гостевых стрелок к детям РАСКРЫТЫХ рамок (own-on-first-render, Ф3).
//
// Излом гостевой стрелки уникален для уровня и хранится в пер-уровневом слое. Чтобы он ехал
// ровно с гостевым концом (и при выталкивании enforce, и при сдвиге коробки-родителя, и при
// драге самого узла), излом привязываем к ИДЕНТИЧНОСТИ узла — `anchor_node_id`:
//   абсолютный_излом = офсет_излома + позиция_узла-якоря (его левый-верхний угол)
// Идентичность хранится явно (не выводится на рендере из «какой конец сейчас потомок раскрытой
// рамки»), поэтому излом гаснет РОВНО при сворачивании своего узла: если узел-якорь не
// отображается — авто-маршрут. Раньше якорь выводился по «любому показанному гостевому концу»,
// и при сворачивании своего конца излом мог перепривязаться к другому концу и зависнуть (баг 3).
//
// Привязку (anchor_node_id) приобретает свежий/легаси АБСОЛЮТНЫЙ путь, чей гостевой конец
// сейчас — отображаемый потомок раскрытой рамки: запоминаем этот узел и персистим офсет (на
// экране без сдвига). Дальше излом владеется этим узлом по идентичности. Абсолют, чей конец
// не в раскрытой рамке (обычный гость / локальная стрелка), якоря не получает — путь как пришёл.
import type { Edge as AppEdge, EdgePoint, LevelWaypoints } from "../../../types";

type XY = { x: number; y: number };

export interface OwnedWaypointsResult {
  /** edge_id → путь в АБСОЛЮТНЫХ координатах уровня (для рендера/обводов) */
  effective: Record<string, EdgePoint[]>;
  /** абсолюты, которые надо персистнуть офсетом с приобретённым anchor_node_id (на экране без сдвига) */
  migrations: { edge_id: string; anchor_node_id: string; waypoints: EdgePoint[] }[];
}

/**
 * `levelEdgeWaypoints` — сырые изломы (с `anchor_node_id`); `edges` — рёбра В ПРОЕКЦИИ
 * (концы = отображаемые сущности), по ним ищем гостевой конец для приобретения якоря; `pos` —
 * финальная позиция сущности; `expandedChildIds` — id отображаемых сущностей, являющихся
 * потомками РАСКРЫТОЙ рамки (их геометрию задаёт раскладка — их и приобретаем в якорь).
 */
export function reconstructOwnedWaypoints(params: {
  levelEdgeWaypoints: Record<string, LevelWaypoints>;
  edges: AppEdge[];
  pos: (id: string) => XY | undefined;
  expandedChildIds: Set<string>;
}): OwnedWaypointsResult {
  const { levelEdgeWaypoints, edges, pos, expandedChildIds } = params;
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  // Кандидат в якорь для ещё не привязанного (абсолютного) пути: гостевой конец стрелки, если
  // он — отображаемый потомок раскрытой рамки. Предпочитаем source, затем target (стрелка между
  // двумя детьми приобретает source). null — приобретать нечего (обычный гость/локальная).
  const acquireAnchor = (e: AppEdge | undefined): string | null => {
    if (!e) return null;
    return expandedChildIds.has(e.source_id)
      ? e.source_id
      : expandedChildIds.has(e.target_id)
        ? e.target_id
        : null;
  };
  const effective: Record<string, EdgePoint[]> = {};
  const migrations: OwnedWaypointsResult["migrations"] = [];
  for (const [edgeId, w] of Object.entries(levelEdgeWaypoints)) {
    if (w.anchor_node_id) {
      // Путь владеется узлом по идентичности.
      const base = pos(w.anchor_node_id);
      if (base) {
        // офсетный путь → абсолют относительно текущей позиции узла-якоря
        effective[edgeId] = w.waypoints.map((pt) => ({ x: pt.x + base.x, y: pt.y + base.y }));
      } else {
        // узел-якорь не отображается (свёрнут) → нет якоря → авто-маршрут (это и чинит баг 3)
        effective[edgeId] = [];
      }
      continue;
    }
    // Привязки нет: путь — абсолют уровня. Если гостевой конец сейчас потомок раскрытой рамки,
    // приобретаем якорь (на экране оставляем как есть, на персист — офсет от узла).
    const anchorId = acquireAnchor(edgeById.get(edgeId));
    const base = anchorId ? pos(anchorId) : undefined;
    if (anchorId && base) {
      effective[edgeId] = w.waypoints;
      migrations.push({
        edge_id: edgeId,
        anchor_node_id: anchorId,
        waypoints: w.waypoints.map((pt) => ({ x: pt.x - base.x, y: pt.y - base.y })),
      });
    } else {
      // обычная гостевая стрелка (конец не в раскрытой рамке) — путь как пришёл
      effective[edgeId] = w.waypoints;
    }
  }
  return { effective, migrations };
}
