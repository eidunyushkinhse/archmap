// Оркестрация выбора связи по двойному клику (общая для редактора-карты и
// встроенных блоков просмотра). Инкапсулирует ТО, что одинаково в обеих
// поверхностях: разрешение группы AppEdge → LevelEdge, решение «одна — сразу
// выбрать / несколько — модалка», само состояние модалки и её рендер с подписями
// концов. (Модалка «общего плеча» E80 снята 2026-10-11 вместе со стволами.)
//
// Что НАМЕРЕННО не здесь — семантика «выбрать связь»: в редакторе это открыть
// инспектор (selectedObject: node|edge|ghost), во просмотре — только подсветка
// полного пути (linkedHighlight). Это решает вызывающая сторона через onPick;
// она же владеет linkedHighlight и очисткой выделения. Так хук не тянет в себя
// разную модель выделения двух поверхностей.
import { useCallback, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Edge, LevelEdge } from "../../../types";
import type { EdgeChoiceEnds } from "../types";
import EdgeChoiceModal from "../../EdgeChoiceModal";

interface UseEdgeChoiceArgs {
  /** AppEdge id → LevelEdge (страница знает свой источник рёбер). */
  resolveEdge: (id: string) => LevelEdge | null;
  /** Имя узла по id — для подписей концов в модалке (fallback projected-id). */
  labelOf: (id: string) => string;
  /** Связь выбрана (одиночным кликом или в модалке) — страница подсвечивает/инспектирует. */
  onPick: (edge: LevelEdge) => void;
  /** Только архитектор редактора: «+ Добавить связь» из модалки. representative — первая
   *  связь пучка, ends — отображаемые концы стрелки, по которой открыто окно: новая связь
   *  ведёт к показанной паре (edge.md E97), к концам первой связи — только без ends. */
  onAddFromChoice?: (representative: LevelEdge, ends?: EdgeChoiceEnds) => void;
}

interface UseEdgeChoiceResult {
  onEdgesChoice: (group: Edge[], ends?: EdgeChoiceEnds) => void;
  /** Готовый к рендеру EdgeChoiceModal или null. */
  choiceModal: ReactNode;
}

// Шапка и вторые строчки окна выбора. Конец, общий у всех связей пучка, называет шапка.
// Конец, у которого связи расходятся (пучок в свёрнутую систему: «Пользователь → Заказы»,
// а связи идут в «Каталог», «Корзину»…), шапка называет отображаемым концом стрелки
// (ends — id узла или рамки, на которые легли настоящие концы), а КАЖДАЯ строка — своим
// настоящим концом: иначе десять одинаковых «пользуется» не различить (edge.md E57).
// Отображаемый конец не известен (общий участок разных стрелок) или не разрешается в имя —
// шапка говорит «несколько объектов». Пустые original-имена (базовый Edge без original_*)
// заменяет имя по id конца.
function choiceLabels(edges: LevelEdge[], ends: EdgeChoiceEnds | undefined, labelOf: (id: string) => string) {
  const srcName = (e: LevelEdge): string => e.original_source_name || labelOf(e.source_id);
  const tgtName = (e: LevelEdge): string => e.original_target_name || labelOf(e.target_id);
  const srcVaries = new Set(edges.map(srcName)).size > 1;
  const tgtVaries = new Set(edges.map(tgtName)).size > 1;
  const shown = (id: string | null | undefined): string => {
    const name = id ? labelOf(id) : null;
    return name && name !== id ? name : "несколько объектов";
  };
  return {
    sourceLabel: srcVaries ? shown(ends?.source) : srcName(edges[0]),
    targetLabel: tgtVaries ? shown(ends?.target) : tgtName(edges[0]),
    endOf: (e: LevelEdge): string | undefined => {
      if (srcVaries && tgtVaries) return `${srcName(e)} → ${tgtName(e)}`;
      if (tgtVaries) return `→ ${tgtName(e)}`;
      if (srcVaries) return `${srcName(e)} →`;
      return undefined;
    },
  };
}

export function useEdgeChoice({
  resolveEdge, labelOf, onPick, onAddFromChoice,
}: UseEdgeChoiceArgs): UseEdgeChoiceResult {
  const [edgeChoice, setEdgeChoice] = useState<{ edges: LevelEdge[]; ends?: EdgeChoiceEnds } | null>(null);

  const resolveGroup = useCallback(
    (group: Edge[]): LevelEdge[] =>
      group.map((g) => resolveEdge(g.id)).filter((e): e is LevelEdge => e != null),
    [resolveEdge],
  );

  // Клик по плашке/линии: одна связь — сразу выбрать, несколько — модалка выбора.
  const onEdgesChoice = useCallback((group: Edge[], ends?: EdgeChoiceEnds) => {
    const les = resolveGroup(group);
    if (les.length === 1) onPick(les[0]);
    else if (les.length > 1) setEdgeChoice({ edges: les, ends });
  }, [resolveGroup, onPick]);

  const choiceModal = useMemo<ReactNode>(() => {
    if (edgeChoice && edgeChoice.edges.length > 0) {
      const { edges } = edgeChoice;
      const labels = choiceLabels(edges, edgeChoice.ends, labelOf);
      return (
        <EdgeChoiceModal
          edges={edges}
          sourceLabel={labels.sourceLabel}
          targetLabel={labels.targetLabel}
          endOf={labels.endOf}
          onPick={(edge) => { setEdgeChoice(null); onPick(edge); }}
          onAdd={onAddFromChoice ? () => { const rep = edges[0]; setEdgeChoice(null); onAddFromChoice(rep, edgeChoice.ends); } : undefined}
          onClose={() => setEdgeChoice(null)}
        />
      );
    }
    return null;
  }, [edgeChoice, onPick, onAddFromChoice, labelOf]);

  return { onEdgesChoice, choiceModal };
}
