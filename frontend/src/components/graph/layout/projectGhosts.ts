// Проекция гостей с учётом свёрнутых контейнеров. Доменная логика expand/collapse —
// под характеризационными тестами Фазы 1.
import type { DisplayContainer, DisplayExternal } from "../types";
import type { GhostNode } from "../../../types";

/**
 * Сворачивает гостя к ближайшему НЕразвёрнутому контейнеру-предку. По умолчанию
 * гость показывается как его верхний контейнер (напр. ProdMon); по мере раскрытия
 * (expanded) — глубже, вплоть до самого гостя. Поиск контейнера идёт от позиции
 * НИЖЕ общего предка с уровнем (lcaPos + 1). Для гостя БЕЗ общего предка (lcaIdx =
 * −1, lcaPos = −1) поиск стартует с самого корня — такой гость тоже сворачивается
 * к верхнему контейнеру-предку (напр. «Объекты мониторинга» вокруг листа «БД»), а
 * не показывается голым листом. Лист видим, лишь когда у гостя вовсе нет предков
 * (сам корень) либо все его контейнеры-предки раскрыты. Возвращает уникальные
 * отображаемые сущности и карту «id гостя → id отображаемой сущности» для ремапа
 * рёбер.
 */
export function projectGhosts(ghostNodes: GhostNode[], ancestorIds: string[], expanded: Set<string>) {
  const bcIndex = new Map(ancestorIds.map((id, i) => [id, i]));
  const entities = new Map<string, DisplayExternal>();
  const ghostToEffective = new Map<string, string>();
  // id отображаемой сущности → id раскрытого контейнера-предка ПРЯМО над ней
  // (тот, чьё раскрытие её обнажило). null/нет ключа — сущность не вышла из
  // раскрытия (верхний контейнер или гость без общей рамки).
  const emergedFrom = new Map<string, string>();

  for (const g of ghostNodes) {
    const anc = g.ancestors ?? [];
    let lcaIdx = -1, lcaPos = -1;
    anc.forEach((a, pos) => {
      const idx = bcIndex.get(a.id);
      if (idx !== undefined && idx > lcaIdx) { lcaIdx = idx; lcaPos = pos; }
    });

    // первый неразвёрнутый контейнер-предок ниже общего предка (для гостя без
    // общего предка lcaPos = −1 → поиск с самого корня)
    let container: DisplayContainer | null = null;
    let foundPos = anc.length; // если контейнер не найден — дошли до самого гостя
    for (let pos = lcaPos + 1; pos < anc.length; pos++) {
      const a = anc[pos];
      if (!expanded.has(a.id)) {
        container = { kind: "container", id: a.id, name: a.name, depth: pos, ancestors: anc.slice(0, pos), is_external: a.is_external };
        foundPos = pos;
        break;
      }
    }
    const displayed: DisplayExternal = container ?? { kind: "leaf", id: g.id, ghost: g };
    // предок прямо над точкой отображения раскрыт → сущность вышла из него
    const emerged: string | null =
      foundPos - 1 >= lcaPos + 1 ? anc[foundPos - 1].id : null;

    ghostToEffective.set(g.id, displayed.id);
    if (!entities.has(displayed.id)) entities.set(displayed.id, displayed);
    if (emerged) emergedFrom.set(displayed.id, emerged);
  }

  return { entities: [...entities.values()], ghostToEffective, emergedFrom };
}
