// СЛОЙ РАССТАНОВКИ ЧИТАТЕЛЯ (решение владельца 2026-11-24, задание П2; view.md V25 v2):
// читатель двигает объекты и переразлагает уровень НА ВРЕМЯ ПРОСМОТРА. Его правки живут
// в памяти холста слоем поверх серверной раскладки вида и никуда не пишутся. Ключ — id
// строки вида, значение — позиция или null (позиция снята сбросом «Переразложить»).
// Раскрытия в слой не попадают: у читателя они эфемерны своим путём (useLevelDrill,
// правки сессии поверх сохранённого). Слой — не копия зеркала: фоновое перечитывание
// уровня меняет серверную часть, а слой лежит поверх неё дальше.
import type { ViewLayout } from "../../../types";
import type { LayoutPatch } from "../types";

type Pos = { x: number; y: number };
export type ReaderLayer = Readonly<Record<string, Pos | null>>;

// Пустой слой — одна ссылка: действующая раскладка без правок остаётся серверной ссылкой
// (конвейер не перезапускается от новой копии того же содержимого).
export const EMPTY_LAYER: ReaderLayer = Object.freeze({});

const posOf = (p: { x?: number | null; y?: number | null } | null | undefined): Pos | null =>
  p?.x != null && p?.y != null ? { x: p.x, y: p.y } : null;

/** Действующая раскладка: серверная, поверх — слой читателя. Пустой слой — та же ссылка. */
export function applyReaderLayer(server: ViewLayout, layer: ReaderLayer): ViewLayout {
  if (Object.keys(layer).length === 0) return server;
  const out: ViewLayout = {};
  // строки сервера без правки слоя — как есть; со снятой позицией — без координат
  // (строка без флага раскрытия уходит совсем)
  for (const [k, row] of Object.entries(server)) {
    if (!(k in layer)) out[k] = row;
    else if (layer[k] === null && row.expanded != null) out[k] = { expanded: row.expanded };
  }
  for (const [k, pos] of Object.entries(layer)) {
    if (pos) out[k] = { ...server[k], x: pos.x, y: pos.y };
  }
  return out;
}

/** Патч канала раскладки → правка слоя: только то, что меняет позиции действующей
 *  раскладки. Строки с полем раскрытия (раскрытие, сворачивание, own-on-expand) слой не
 *  берёт: раскрытость у читателя живёт правками сессии. */
export function readerLayerPatch(patch: LayoutPatch, effective: ViewLayout): Record<string, Pos | null> {
  const out: Record<string, Pos | null> = {};
  for (const [k, p] of Object.entries(patch)) {
    if (p !== null && p.expanded !== undefined) continue;
    const pos = posOf(p);
    const cur = posOf(effective[k]);
    if (pos === null ? cur === null : cur !== null && cur.x === pos.x && cur.y === pos.y) continue;
    out[k] = pos;
  }
  return out;
}

/** Засев, накопленный до первой правки читателя, достаётся только ключам без позиции в
 *  действующей раскладке (архитектор мог успеть сохранить свою). */
export function pendingSeeds(seeds: Record<string, Pos | null>, effective: ViewLayout): Record<string, Pos> {
  const out: Record<string, Pos> = {};
  for (const [k, pos] of Object.entries(seeds)) {
    if (pos && posOf(effective[k]) === null) out[k] = pos;
  }
  return out;
}
