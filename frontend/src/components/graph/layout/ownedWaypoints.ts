// Реконструкция изломов пучков к детям РАСКРЫТЫХ рамок (own-on-first-render, Ф3/R3).
//
// Излом пучка хранится в view_layout ("b:<src>><tgt>" → {waypoints, anchor}). Чтобы он
// ехал ровно с гостевым концом (и при выталкивании enforce, и при сдвиге коробки-родителя,
// и при драге самого узла), излом привязывается к ИДЕНТИЧНОСТИ узла — anchor:
//   абсолютный_излом = офсет_излома + позиция_узла-якоря (его левый-верхний угол)
// Идентичность хранится явно (не выводится на рендере из «какой конец сейчас потомок
// раскрытой рамки»), поэтому излом гаснет РОВНО при сворачивании своего узла: если
// узел-якорь не отображается — авто-маршрут.
//
// Привязку (anchor) приобретает свежий/легаси АБСОЛЮТНЫЙ путь, чей конец сейчас —
// отображаемый потомок раскрытой рамки: запоминаем этот узел и персистим офсет (на
// экране без сдвига; интентом own-bundle-waypoints). Дальше излом владеется узлом по
// идентичности. Абсолют, чей конец не в раскрытой рамке (обычный гость / локальная
// стрелка), якоря не получает — путь как пришёл.
import type { EdgePoint } from "../../../types";

type XY = { x: number; y: number };

// Геометрия изломов одного пучка: пара отображаемых концов (из ключа) + путь + якорь.
export interface BundleWaypoints {
  source: string;
  target: string;
  waypoints: EdgePoint[];
  anchor?: string | null;
}

export interface OwnedWaypointsResult {
  /** ключ пучка → путь в АБСОЛЮТНЫХ координатах вида (для рендера/роутинга) */
  effective: Record<string, EdgePoint[]>;
  /** абсолюты, которые надо персистнуть офсетом с приобретённым якорем (без сдвига на экране) */
  migrations: { itemId: string; waypoints: EdgePoint[]; anchor: string }[];
}

/**
 * `bundles` — изломы пучков (ключ пучка → геометрия с концами); `pos` — финальная
 * позиция сущности; `expandedChildIds` — id отображаемых сущностей, являющихся
 * потомками РАСКРЫТОЙ рамки (их геометрию задаёт раскладка — их и приобретаем в якорь).
 */
export function reconstructOwnedWaypoints(params: {
  bundles: Record<string, BundleWaypoints>;
  pos: (id: string) => XY | undefined;
  expandedChildIds: Set<string>;
}): OwnedWaypointsResult {
  const { bundles, pos, expandedChildIds } = params;
  // Кандидат в якорь для ещё не привязанного (абсолютного) пути: конец пучка, если
  // он — отображаемый потомок раскрытой рамки. Предпочитаем source, затем target
  // (пучок между двумя детьми приобретает source). null — приобретать нечего.
  const acquireAnchor = (b: BundleWaypoints): string | null =>
    expandedChildIds.has(b.source)
      ? b.source
      : expandedChildIds.has(b.target)
        ? b.target
        : null;

  const effective: Record<string, EdgePoint[]> = {};
  const migrations: OwnedWaypointsResult["migrations"] = [];
  for (const [itemId, b] of Object.entries(bundles)) {
    if (b.anchor) {
      // Путь владеется узлом по идентичности.
      const base = pos(b.anchor);
      if (base) {
        // офсетный путь → абсолют относительно текущей позиции узла-якоря
        effective[itemId] = b.waypoints.map((pt) => ({ x: pt.x + base.x, y: pt.y + base.y }));
      } else {
        // узел-якорь не отображается (свёрнут) → нет якоря → авто-маршрут
        effective[itemId] = [];
      }
      continue;
    }
    // Привязки нет: путь — абсолют вида. Если конец пучка сейчас потомок раскрытой
    // рамки, приобретаем якорь (на экране оставляем как есть, на персист — офсет).
    const anchorId = acquireAnchor(b);
    const base = anchorId ? pos(anchorId) : undefined;
    if (anchorId && base) {
      effective[itemId] = b.waypoints;
      migrations.push({
        itemId,
        anchor: anchorId,
        waypoints: b.waypoints.map((pt) => ({ x: pt.x - base.x, y: pt.y - base.y })),
      });
    } else {
      // обычный пучок (конец не в раскрытой рамке) — путь как пришёл
      effective[itemId] = b.waypoints;
    }
  }
  return { effective, migrations };
}
