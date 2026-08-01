// Оценка габаритов плашки подписи ребра ДО рендера — предусловие R2 эпика стрелок
// (плашки не наползают друг на друга и не под узлами). Точную ширину знает только DOM
// (getBBox в WrappedLabelEdge), но для авто-размещения плашек без наложений габариты
// нужны ДО рендера. Здесь — моноширинная аппроксимация под шрифт 11px.
// См. docs/archive/ARROWS_ROUTING_ANALYSIS.md §5.
//
// Параметры взяты из рендера level-плашки (graph/edges.tsx): fontSize 11, lineHeight 1.4,
// padding "2px 7px" (одиночная подпись), border 1px.

import { wrapLabel } from "../text";

export const LABEL_FONT_PX = 11;        // размер шрифта плашки
export const LABEL_CHAR_PX = 6.3;       // средняя ширина символа при 11px (моноширинная оценка)
const LABEL_PAD_X = 7;                   // горизонтальный padding одиночной плашки
const LABEL_PAD_Y = 2;                   // вертикальный padding одиночной плашки
const LABEL_BORDER = 1;                  // рамка плашки (с каждой стороны)
// Высота одной строки текста, px. ceil(11*1.4)=16 — округляем ВВЕРХ: для R2 оценка
// должна быть консервативной (лучше зарезервировать чуть больше, чем пропустить наложение).
const LABEL_LINE_PX = Math.ceil(LABEL_FONT_PX * 1.4);

// «Обвязка» плашки по ширине: padding + border с обеих сторон. Равна 16 — то же
// слагаемое, что в ctxLabelWidth (контекст), поэтому оценки согласованы.
export const LABEL_CHROME_X = 2 * (LABEL_PAD_X + LABEL_BORDER);
// «Обвязка» по высоте: padding + border сверху и снизу.
export const LABEL_CHROME_Y = 2 * (LABEL_PAD_Y + LABEL_BORDER);

export interface Size {
  w: number;
  h: number;
}

// Оценочная ширина строки текста БЕЗ обвязки плашки, px.
export function estimateTextWidth(text: string): number {
  return Math.round(text.length * LABEL_CHAR_PX);
}

// Полные габариты плашки подписи (с паддингом и рамкой). lines — число строк текста
// (для мастер-стрелки/переноса), maxWidth — кап ширины (как CTX_LABEL_W): при капе текст
// переносится, поэтому ширину зажимаем, а высоту считает вызывающий по факт. числу строк.
export function labelBoxSize(
  text: string,
  opts?: { lines?: number; maxWidth?: number },
): Size {
  const lines = Math.max(1, opts?.lines ?? 1);
  let w = estimateTextWidth(text) + LABEL_CHROME_X;
  if (opts?.maxWidth != null) w = Math.min(w, opts.maxWidth);
  const h = lines * LABEL_LINE_PX + LABEL_CHROME_Y;
  return { w, h };
}

/**
 * Габариты ОДИНОЧНОЙ level-плашки С УЧЁТОМ ПЕРЕНОСА, как её реально рендерит
 * WrappedLabelEdge (wrapLabel по ~20 символов на строку): ширина — по самой
 * длинной строке после переноса, высота — по числу строк. Оценка labelBoxSize
 * без переноса завышает ширину полного текста в полтора-два раза.
 */
export function wrappedLabelBoxSize(textLines: string[]): Size {
  const longest = textLines.reduce((a, b) => (b.length > a.length ? b : a), "");
  return {
    w: estimateTextWidth(longest) + LABEL_CHROME_X,
    h: Math.max(1, textLines.length) * LABEL_LINE_PX + LABEL_CHROME_Y,
  };
}

/**
 * ЕДИНАЯ оценка габаритов плашки группы по её edgeLabelMeta (Ф2 эпика
 * «структура и воздух»): одиночная подпись — wrapped-модель (рендер переносит
 * текст, старая оценка полной строки завышала ширину в 1.5–2 раза → лишние
 * выносы и лишняя раздвижка A10); мастер (lines > 1) — прежняя модель
 * (буллет-список рендерится иначе, его уточнение — вне скоупа Ф2).
 * Все потребители (A10, размещение плашек, живой драг, детуры) обязаны
 * пользоваться этой функцией, а не labelBoxSize напрямую — иначе оценки
 * разойдутся между стадиями.
 */
export function metaLabelBox(meta: { text: string; lines: number }): Size {
  if (meta.lines === 1) return wrappedLabelBoxSize(wrapLabel(meta.text));
  return labelBoxSize(meta.text, { lines: meta.lines });
}
