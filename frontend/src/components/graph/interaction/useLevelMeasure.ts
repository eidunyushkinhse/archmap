// Замер реальных габаритов узлов (V2.2b, паттерн render→measure→layout). Вынесено
// из LevelGraph.tsx (Фаза 3г) без изменения поведения: ref-мост размеров и обработчик
// 'dimensions'-событий RF изолированы — зависят только от базового onNodesChange
// (useSnapAlignment) и getInternalNode (useReactFlow владельца).
//
// РЕАЛЬНЫЕ габариты узлов (node.measured — v12 пишет их в контролируемый стейт через
// onNodesChange 'dimensions'). Паттерн render→measure→layout: при смене СИГНАТУРЫ
// размеров (не позиций/выделения!) перезапускаем раскладку — стадии качества стрелок
// получают настоящие тела вместо фолбэка NODE_W×NODE_H. useNodesInitialized не
// годится: флипается до публикации замеров (xyflow#4202). Петли нет: пере-раскладка
// размеров не меняет → сигнатура стабильна → второго перезапуска не будет.
//
// Размеры только НАКАПЛИВАЮТСЯ: сборка пересоздаёт RF-узлы без measured (замер
// доезжает отдельным 'dimensions'-событием позже) — сигнатура «полный↔неполный набор»
// мигала бы и бесконечно перезапускала раскладку. Запись живёт, пока узел не
// перемеряется ИНАЧЕ; исчезновение узла записи не трогает (устаревшие безвредны —
// конвейер смотрит по id).
import { useCallback, useRef, useState } from "react";
import type { Node as RFNode, NodeChange, ReactFlowInstance } from "@xyflow/react";

interface UseLevelMeasureArgs {
  // базовый обработчик изменений RF (useSnapAlignment): пропускаем через себя
  // весь поток, сверху накапливая только 'dimensions'
  handleNodesChange: (changes: NodeChange<RFNode>[]) => void;
  // читалка внутреннего узла RF (useReactFlow владельца) — тип узла для фильтра
  getInternalNode: ReactFlowInstance["getInternalNode"];
}

export interface LevelMeasure {
  // реальные габариты узлов (id → {w, h}), накопленные по 'dimensions'-событиям
  nodeSizesRef: React.RefObject<Record<string, { w: number; h: number }>>;
  // счётчик новых замеров: зависимость эффекта раскладки (перезапуск при реально
  // новом размере) и гейт авто-фита загрузки (fitOnLoad ждёт ≥ 1)
  sizesVersion: number;
  // поток 'dimensions' → накопление размеров; ставится на onNodesChange RF
  handleNodesChangeMeasured: (changes: NodeChange<RFNode>[]) => void;
}

export function useLevelMeasure({
  handleNodesChange, getInternalNode,
}: UseLevelMeasureArgs): LevelMeasure {
  const nodeSizesRef = useRef<Record<string, { w: number; h: number }>>({});
  const [sizesVersion, setSizesVersion] = useState(0);

  // Поток 'dimensions'-изменений RF (замер узлов) → накопление реальных габаритов и
  // перезапуск раскладки при реально новом размере (V2.2b, паттерн render→measure→layout;
  // setState в колбэке внешней системы — легален, в отличие от эффекта по rfNodes).
  const handleNodesChangeMeasured = useCallback((changes: NodeChange<RFNode>[]) => {
    handleNodesChange(changes);
    // копия словаря размеров — лениво, только при dimensions-изменениях: обычный
    // position-тик драга не должен аллоцировать её на каждый кадр
    if (!changes.some((ch) => ch.type === "dimensions")) return;
    let changed = false;
    const merged = { ...nodeSizesRef.current };
    for (const ch of changes) {
      if (ch.type !== "dimensions" || !ch.dimensions) continue;
      const t = getInternalNode(ch.id)?.type;
      if (t === "frame" || t === "spacer") continue;
      const w = Math.round(ch.dimensions.width * 2) / 2, h = Math.round(ch.dimensions.height * 2) / 2;
      if (!w || !h) continue;
      const prev = merged[ch.id];
      if (!prev || prev.w !== w || prev.h !== h) { merged[ch.id] = { w, h }; changed = true; }
    }
    if (changed) {
      nodeSizesRef.current = merged;
      const dbg = window as unknown as { __archmapSizesVersion?: number };
      dbg.__archmapSizesVersion = (dbg.__archmapSizesVersion ?? 0) + 1;
      setSizesVersion((v) => v + 1);
    }
  }, [handleNodesChange, getInternalNode]);

  return { nodeSizesRef, sizesVersion, handleNodesChangeMeasured };
}
