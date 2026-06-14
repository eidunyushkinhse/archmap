// Плечо канала: визуальный стиль типа сообщения (вызов / ответ / событие).
// Портировано из дизайн-референса (bp-parts.jsx legMeta).
import type { ComponentType } from "react";
import type { MessageKind } from "../../types";
import { IcoArrowR, IcoAsync, IcoReturn } from "./icons";
import { BPT } from "./tokens";

export interface LegMeta {
  ink: string;
  bg: string;
  line: string;
  Icon: ComponentType<{ s?: number }>;
  word: string;
}

export function legMeta(kind: MessageKind): LegMeta {
  if (kind === "return")
    return { ink: BPT.retInk, bg: "#f4f1ff", line: "#ddd5ff", Icon: IcoReturn, word: "ответ" };
  if (kind === "async")
    return { ink: BPT.asyncInk, bg: "#ecfeff", line: "#bae6f0", Icon: IcoAsync, word: "событие" };
  return { ink: BPT.accent, bg: BPT.wash, line: "#cfe0fd", Icon: IcoArrowR, word: "вызов" };
}
