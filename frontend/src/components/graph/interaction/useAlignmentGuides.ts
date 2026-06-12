// Состояние центральных направляющих магнитного выравнивания. Тонкий хук, но
// состоянием guides владеют сразу snap-драг и drop-шаблона — поэтому общий.
import { useState, useCallback } from "react";
import type { SpacingGuide } from "./distribute";

export interface Guides {
  x: number | null;
  y: number | null;
  // Индикаторы равных зазоров (distribution-снап). Пусто — не показываем.
  spacing: SpacingGuide[];
}

export function useAlignmentGuides() {
  // Координаты (в системе графа) центральных направляющих, пока узел «магнитится»;
  // плюс индикаторы равных зазоров. null/[] по оси — направляющей нет. Сбрасываются
  // по окончании драга.
  const [guides, setGuides] = useState<Guides>({ x: null, y: null, spacing: [] });

  // Скрываем направляющие (обе оси + зазоры) — общий помощник для разных мест.
  const clearGuides = useCallback(() => {
    setGuides((g) =>
      g.x === null && g.y === null && g.spacing.length === 0
        ? g
        : { x: null, y: null, spacing: [] },
    );
  }, []);

  return { guides, setGuides, clearGuides };
}
