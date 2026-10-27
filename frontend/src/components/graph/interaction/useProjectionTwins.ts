// «БЛИЗНЕЦЫ» ВЫДЕЛЕННОГО БЛОКА (проекция хозяина, холст развёртывания —
// docs/specs/deployment.md): объект стоит на нескольких площадках и нарисован
// карточкой в каждой рамке; выделение одной карточки подсвечивает и остальные
// карточки того же объекта. Группу карточки называет хозяин (groupOf).
//
// Механика — как у устойчивой подсветки useLevelSelection: класс lg-linked-node
// вешается императивно на DOM по data-id, снимается в cleanup. RF-выделение остаётся
// на самой карточке: выдели мы близнецов по-настоящему, драг одной карточки тащил бы
// их по чужим рамкам. Зависимость от rfNodes — переналожение после пере-раскладки
// (RF переписывает className узла целиком, когда меняется его состояние).
import { useEffect, useMemo } from "react";
import type { Node as RFNode } from "@xyflow/react";

interface UseProjectionTwinsArgs {
  groupOf?: (id: string) => string | undefined;
  rfNodes: RFNode[];
}

/** id близнецов выделенных блоков: те же группы, сами не выделены. Чистая функция. */
function twinIds(rfNodes: readonly RFNode[], groupOf: (id: string) => string | undefined): string[] {
  const groups = new Set<string>();
  for (const n of rfNodes) {
    if (n.type !== "block" || !n.selected) continue;
    const g = groupOf(n.id);
    if (g !== undefined) groups.add(g);
  }
  if (groups.size === 0) return [];
  const out: string[] = [];
  for (const n of rfNodes) {
    if (n.type !== "block" || n.selected) continue;
    const g = groupOf(n.id);
    if (g !== undefined && groups.has(g)) out.push(n.id);
  }
  return out.sort();
}

export function useProjectionTwins({ groupOf, rfNodes }: UseProjectionTwinsArgs): void {
  // Набор близнецов ПО ЗНАЧЕНИЮ: на драг-тиках rfNodes меняется, а набор — нет.
  const key = useMemo(() => (groupOf ? twinIds(rfNodes, groupOf).join("\n") : ""), [groupOf, rfNodes]);
  useEffect(() => {
    if (!key) return;
    const ids = key.split("\n");
    let applied: Element[] = [];
    const raf = requestAnimationFrame(() => {
      for (const id of ids) {
        const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
        if (el) { el.classList.add("lg-linked-node"); applied.push(el); }
      }
    });
    return () => {
      cancelAnimationFrame(raf);
      for (const el of applied) el.classList.remove("lg-linked-node");
      applied = [];
    };
    // rfNodes — зависимость-триггер (тело его не читает): переналожение после
    // пере-раскладки/ремаунта узлов, как у useLevelSelection.
  }, [key, rfNodes]);
}
