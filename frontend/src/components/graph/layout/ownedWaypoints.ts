// Реконструкция изломов гостевых стрелок ВЛАДЕЕМЫХ групп (ТЗ D8).
//
// Изломы владеемой группы (раскрытая гостевая рамка, чьи дети запинены) хранятся ОФСЕТОМ
// от живого якоря — зеркало модели позиций (anchor_rel). Чтобы излом ехал ровно с уехавшей
// рамкой (и при поездке за якорем, и при выталкивании enforce), его абсолют считаем по тому
// же базису, что и позицию ребёнка:
//   anchorЭфф(ребёнка) = его финальная позиция − сохранённый офсет позиции
//   абсолютный_излом   = офсет_излома + anchorЭфф
// anchorЭфф берётся из САМОГО ребёнка (его pos уже после колец+enforce), поэтому никакого
// отдельного знания о сдвиге не нужно — излом наследует тот же суммарный перенос.
//
// Легаси-абсолютные изломы владеемой группы лениво мигрируем в офсет (как позиции): на
// экране не двигаем, но возвращаем офсет на персист с anchor_rel=true. Свёрнутая/невладеемая
// стрелка офсетного пути не имеет якоря в кадре → отдаём авто-маршрут (пустой путь).
import type { Edge as AppEdge, EdgePoint, LevelPos, LevelWaypoints } from "../../../types";

type XY = { x: number; y: number };

export interface OwnedWaypointsResult {
  /** edge_id → путь в АБСОЛЮТНЫХ координатах уровня (для рендера/обводов) */
  effective: Record<string, EdgePoint[]>;
  /** легаси-абсолюты, которые надо персистнуть офсетом с anchor_rel=true (на экране без сдвига) */
  migrations: { edge_id: string; waypoints: EdgePoint[] }[];
}

/**
 * `levelEdgeWaypoints` — сырые изломы (с флагом anchor_rel); `edges` — рёбра В ПРОЕКЦИИ
 * (концы = отображаемые сущности), по ним ищем гостевой конец; `levelPositions` — позиции
 * уровня (anchor_rel помечает владеемого ребёнка); `pos` — финальная позиция сущности;
 * `expandedChildIds` — id отображаемых сущностей, являющихся потомками РАСКРЫТОЙ рамки
 * (их дефолтная геометрия задаётся раскладкой, не ручным абсолютом).
 */
export function reconstructOwnedWaypoints(params: {
  levelEdgeWaypoints: Record<string, LevelWaypoints>;
  edges: AppEdge[];
  levelPositions: Record<string, LevelPos>;
  pos: (id: string) => XY | undefined;
  expandedChildIds: Set<string>;
}): OwnedWaypointsResult {
  const { levelEdgeWaypoints, edges, levelPositions, pos, expandedChildIds } = params;
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  // якорь владеемого ребёнка = его позиция − офсет позиции (тот же базис, что у позиции)
  const ownedAnchor = (entId: string): XY | null => {
    const lp = levelPositions[entId];
    const p = pos(entId);
    return lp && lp.anchor_rel && p ? { x: p.x - lp.pos_x, y: p.y - lp.pos_y } : null;
  };
  const effective: Record<string, EdgePoint[]> = {};
  const migrations: { edge_id: string; waypoints: EdgePoint[] }[] = [];
  for (const [edgeId, w] of Object.entries(levelEdgeWaypoints)) {
    const e = edgeById.get(edgeId);
    // гостевой конец стрелки среди владеемых детей (любой конец); локал → null
    const anchor = e ? (ownedAnchor(e.source_id) ?? ownedAnchor(e.target_id)) : null;
    if (w.anchor_rel) {
      // офсетный путь: реконструируем, только если рамка раскрыта и ребёнок на экране;
      // иначе якоря в кадре нет → авто-маршрут (старый ручной путь к свёрнутой не применим)
      effective[edgeId] = anchor
        ? w.waypoints.map((pt) => ({ x: pt.x + anchor.x, y: pt.y + anchor.y }))
        : [];
    } else if (anchor) {
      // легаси-абсолют владеемого ребёнка → офсет (на экране оставляем абсолют как есть)
      effective[edgeId] = w.waypoints;
      migrations.push({ edge_id: edgeId, waypoints: w.waypoints.map((pt) => ({ x: pt.x - anchor.x, y: pt.y - anchor.y })) });
    } else if (e && (expandedChildIds.has(e.source_id) || expandedChildIds.has(e.target_id))) {
      // Фикс A: абсолютный излом, чей гостевой конец — АВТО-потомок раскрытой рамки (не
      // владеемый: anchor=null). Этот абсолют рисовался в СВЁРНУТОЙ проекции (конец вёл к
      // коробке); после раскрытия ребёнок переехал раскладкой → старый путь рисуется коряво
      // с лишними пересечениями. Зеркалим поведение офсетных путей «нет якоря в кадре» —
      // отдаём авто-маршрут (пустой путь). Ручной излом по-прежнему можно вернуть пином (B).
      effective[edgeId] = [];
    } else {
      // обычная гостевая стрелка (не владеемая группа, конец не в раскрытой рамке) — как пришёл
      effective[edgeId] = w.waypoints;
    }
  }
  return { effective, migrations };
}
