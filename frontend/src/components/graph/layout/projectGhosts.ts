// Проекция гостей с учётом свёрнутых контейнеров. Доменная логика expand/collapse —
// под характеризационными тестами Фазы 1.
import type { DisplayContainer, DisplayExternal } from "../types";
import type { GhostNode } from "../../../types";

/**
 * Сворачивает гостя к ближайшему НЕразвёрнутому контейнеру-предку (ниже общего
 * предка с текущим уровнем). По умолчанию гость показывается как его верхний
 * контейнер (напр. ProdMon); по мере раскрытия (expanded) — глубже, вплоть до
 * самого гостя. Возвращает уникальные отображаемые сущности и карту
 * «id гостя → id отображаемой сущности» для ремапа рёбер.
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

    let displayed: DisplayExternal;
    let emerged: string | null = null;
    if (lcaIdx === -1) {
      // нет общего предка-рамки → гость показывается как есть (снаружи рамок)
      displayed = { kind: "leaf", id: g.id, ghost: g };
    } else {
      // первый неразвёрнутый контейнер ниже общего предка
      let container: DisplayContainer | null = null;
      let foundPos = anc.length; // если контейнер не найден — дошли до самого гостя
      for (let pos = lcaPos + 1; pos < anc.length; pos++) {
        const a = anc[pos];
        if (!expanded.has(a.id)) {
          container = { kind: "container", id: a.id, name: a.name, depth: pos, ancestors: anc.slice(0, pos) };
          foundPos = pos;
          break;
        }
      }
      displayed = container ?? { kind: "leaf", id: g.id, ghost: g };
      // предок прямо над точкой отображения раскрыт → сущность вышла из него
      if (foundPos - 1 >= lcaPos + 1) emerged = anc[foundPos - 1].id;
    }

    ghostToEffective.set(g.id, displayed.id);
    if (!entities.has(displayed.id)) entities.set(displayed.id, displayed);
    if (emerged) emergedFrom.set(displayed.id, emerged);
  }

  return { entities: [...entities.values()], ghostToEffective, emergedFrom };
}
