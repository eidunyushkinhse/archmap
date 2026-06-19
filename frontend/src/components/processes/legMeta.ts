// Тип сообщения = ФОРМА плеча (линия + наконечник), а НЕ цвет. Цвет задаёт статус
// узла-конца (см. STATUS_LEG). UML-конвенция: синхронный вызов — сплошная + закрашенный
// треугольник; ответ — пунктир + открытая «галка»; асинхронное событие — сплошная +
// открытая «галка». Три типа различимы без цвета.
import type { ComponentType } from "react";
import type { MessageKind } from "../../types";
import { IcoArrowR, IcoAsync, IcoReturn } from "./icons";

export interface LegShape {
  Icon: ComponentType<{ s?: number }>;
  word: string; // «вызов» | «ответ» | «событие»
  dash: string; // "none" | "6 4"
  cap: "fill" | "open"; // закрашенный треугольник | открытая «галка»
}

export function legMeta(kind: MessageKind): LegShape {
  if (kind === "return") return { Icon: IcoReturn, word: "ответ", dash: "6 4", cap: "open" };
  if (kind === "async") return { Icon: IcoAsync, word: "событие", dash: "none", cap: "open" };
  return { Icon: IcoArrowR, word: "вызов", dash: "none", cap: "fill" };
}
