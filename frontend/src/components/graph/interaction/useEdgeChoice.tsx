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
import EdgeChoiceModal from "../../EdgeChoiceModal";

interface UseEdgeChoiceArgs {
  /** AppEdge id → LevelEdge (страница знает свой источник рёбер). */
  resolveEdge: (id: string) => LevelEdge | null;
  /** Имя узла по id — для подписей концов в модалке (fallback projected-id). */
  labelOf: (id: string) => string;
  /** Связь выбрана (одиночным кликом или в модалке) — страница подсвечивает/инспектирует. */
  onPick: (edge: LevelEdge) => void;
  /** Только архитектор редактора: дозаписать связь в том же направлении из модалки. */
  onAddFromChoice?: (representative: LevelEdge) => void;
}

interface UseEdgeChoiceResult {
  onEdgesChoice: (group: Edge[]) => void;
  /** Готовый к рендеру EdgeChoiceModal или null. */
  choiceModal: ReactNode;
}

export function useEdgeChoice({
  resolveEdge, labelOf, onPick, onAddFromChoice,
}: UseEdgeChoiceArgs): UseEdgeChoiceResult {
  const [edgeChoice, setEdgeChoice] = useState<LevelEdge[] | null>(null);

  const resolveGroup = useCallback(
    (group: Edge[]): LevelEdge[] =>
      group.map((g) => resolveEdge(g.id)).filter((e): e is LevelEdge => e != null),
    [resolveEdge],
  );

  // Клик по плашке/линии: одна связь — сразу выбрать, несколько — модалка выбора.
  const onEdgesChoice = useCallback((group: Edge[]) => {
    const les = resolveGroup(group);
    if (les.length === 1) onPick(les[0]);
    else if (les.length > 1) setEdgeChoice(les);
  }, [resolveGroup, onPick]);

  // Подпись конца пучка: если все original-имена совпадают — оно, иначе имя
  // спроецированного представителя (как edgeEndLabel в редакторе). Пустые имена
  // (базовый Edge без original_*) отбрасываются — фолбэк на labelOf по id конца.
  const endLabel = useCallback((names: string[], projectedId: string): string => {
    const present = names.filter((n): n is string => !!n);
    const uniq = new Set(present);
    return uniq.size === 1 ? present[0] : labelOf(projectedId);
  }, [labelOf]);

  const choiceModal = useMemo<ReactNode>(() => {
    if (edgeChoice && edgeChoice.length > 0) {
      return (
        <EdgeChoiceModal
          edges={edgeChoice}
          sourceLabel={endLabel(edgeChoice.map((e) => e.original_source_name), edgeChoice[0].source_id)}
          targetLabel={endLabel(edgeChoice.map((e) => e.original_target_name), edgeChoice[0].target_id)}
          onPick={(edge) => { setEdgeChoice(null); onPick(edge); }}
          onAdd={onAddFromChoice ? () => { const rep = edgeChoice[0]; setEdgeChoice(null); onAddFromChoice(rep); } : undefined}
          onClose={() => setEdgeChoice(null)}
        />
      );
    }
    return null;
  }, [edgeChoice, onPick, onAddFromChoice, endLabel]);

  return { onEdgesChoice, choiceModal };
}
