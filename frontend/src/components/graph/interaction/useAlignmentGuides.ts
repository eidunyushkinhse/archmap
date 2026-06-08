// Состояние центральных направляющих магнитного выравнивания. Тонкий хук, но
// состоянием guides владеют сразу snap-драг и drop-шаблона — поэтому общий.
import { useState, useCallback } from "react";

export interface Guides { x: number | null; y: number | null }

export function useAlignmentGuides() {
  // Координаты (в системе графа) центральных направляющих, пока узел «магнитится».
  // null по оси — направляющей нет. Сбрасываются по окончании драга.
  const [guides, setGuides] = useState<Guides>({ x: null, y: null });

  // Скрываем направляющие (обе оси) — общий помощник для разных мест.
  const clearGuides = useCallback(() => {
    setGuides((g) => (g.x === null && g.y === null ? g : { x: null, y: null }));
  }, []);

  return { guides, setGuides, clearGuides };
}
