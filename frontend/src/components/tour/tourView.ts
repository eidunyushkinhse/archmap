// Что рисует слой тура в текущем кадре (считает TourRuntime, рисует TourLayer).
import type { Hole, Rect } from "./tourGeometry";

export interface TourView {
  /** hidden — открыто чужое окно; pending — цель ещё грузится; center — приветствие и
   *  финал; spot — цель найдена; docked — пользователь не на экране шага */
  phase: "hidden" | "pending" | "center" | "spot" | "docked";
  /** куда рисовать: открытый модальный <dialog> (остальное под ним инертно) или body */
  host: HTMLElement | null;
  holes: Hole[];
  anchor: Rect | null;
  avoid: Rect[];
  /** что карточке лучше не закрывать (зона второго выреза) — см. placeCard */
  soft: Rect[];
}

export const HIDDEN_VIEW: TourView = { phase: "hidden", host: null, holes: [], anchor: null, avoid: [], soft: [] };
