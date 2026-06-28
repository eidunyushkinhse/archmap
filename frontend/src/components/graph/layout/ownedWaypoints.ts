// Реконструкция изломов гостевых стрелок к детям РАСКРЫТЫХ рамок (ТЗ D8, ревизия B).
//
// Излом гостевой стрелки уникален для уровня и хранится в пер-уровневом слое. Чтобы он ехал
// ровно с гостевым концом (и при поездке рамки за якорем, и при выталкивании enforce, и при
// сдвиге коробки-родителя), излом привязываем к СОБСТВЕННОЙ текущей позиции гостевого конца,
// если этот конец — отображаемый потомок раскрытой рамки:
//   абсолютный_излом = офсет_излома + позиция_гостевого_конца (его левый-верхний угол)
// Позиция конца уже финальная (после колец/enforce/сдвига коробки), поэтому излом наследует
// тот же суммарный перенос БЕЗ знания о владении узлом (anchor_rel позиции). Это сознательно
// развязывает геометрию излома и модель «владения» узла: излом липнет к ребёнку, независимо
// от того, пиненная это группа (D4) или ещё авто-ребёнок. Раньше привязка требовала владения
// → на свежей стрелке к авто-ребёнку излом не сохранялся (баг: «по отпусканию встаёт назад»).
//
// Легаси-абсолютные изломы лениво мигрируем в офсет (на экране не двигаем, но возвращаем
// офсет на персист с anchor_rel=true). Изломы стрелок, чей гостевой конец НЕ в раскрытой
// рамке (свёрнут / обычный гость), офсетного якоря в кадре не имеют → офсетный путь даёт
// авто-маршрут (пусто), абсолютный путь остаётся как пришёл (прежнее поведение).
import type { Edge as AppEdge, EdgePoint, LevelWaypoints } from "../../../types";

type XY = { x: number; y: number };

export interface OwnedWaypointsResult {
  /** edge_id → путь в АБСОЛЮТНЫХ координатах уровня (для рендера/обводов) */
  effective: Record<string, EdgePoint[]>;
  /** легаси-абсолюты, которые надо персистнуть офсетом с anchor_rel=true (на экране без сдвига) */
  migrations: { edge_id: string; waypoints: EdgePoint[] }[];
}

/**
 * `levelEdgeWaypoints` — сырые изломы (с флагом anchor_rel); `edges` — рёбра В ПРОЕКЦИИ
 * (концы = отображаемые сущности), по ним ищем гостевой конец; `pos` — финальная позиция
 * сущности; `expandedChildIds` — id отображаемых сущностей, являющихся потомками РАСКРЫТОЙ
 * рамки (их геометрию задаёт раскладка — к ним и привязываем излом).
 */
export function reconstructOwnedWaypoints(params: {
  levelEdgeWaypoints: Record<string, LevelWaypoints>;
  edges: AppEdge[];
  pos: (id: string) => XY | undefined;
  expandedChildIds: Set<string>;
}): OwnedWaypointsResult {
  const { levelEdgeWaypoints, edges, pos, expandedChildIds } = params;
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  // База офсета = позиция гостевого конца стрелки, если он — потомок раскрытой рамки на
  // экране. Предпочитаем source, затем target (стрелка между двумя детьми едет за source).
  const childBase = (e: AppEdge | undefined): XY | null => {
    if (!e) return null;
    const id = expandedChildIds.has(e.source_id)
      ? e.source_id
      : expandedChildIds.has(e.target_id)
        ? e.target_id
        : null;
    return id ? (pos(id) ?? null) : null;
  };
  const effective: Record<string, EdgePoint[]> = {};
  const migrations: { edge_id: string; waypoints: EdgePoint[] }[] = [];
  for (const [edgeId, w] of Object.entries(levelEdgeWaypoints)) {
    const base = childBase(edgeById.get(edgeId));
    if (base) {
      if (w.anchor_rel) {
        // офсетный путь → абсолют относительно текущей позиции гостевого конца
        effective[edgeId] = w.waypoints.map((pt) => ({ x: pt.x + base.x, y: pt.y + base.y }));
      } else {
        // легаси/свежий абсолют к потомку раскрытой рамки → офсет (на экране оставляем как есть)
        effective[edgeId] = w.waypoints;
        migrations.push({ edge_id: edgeId, waypoints: w.waypoints.map((pt) => ({ x: pt.x - base.x, y: pt.y - base.y })) });
      }
    } else if (w.anchor_rel) {
      // офсетный путь, но гостевой конец не на экране (свёрнут) → нет якоря → авто-маршрут
      effective[edgeId] = [];
    } else {
      // обычная гостевая стрелка (конец не в раскрытой рамке) — путь как пришёл
      effective[edgeId] = w.waypoints;
    }
  }
  return { effective, migrations };
}
