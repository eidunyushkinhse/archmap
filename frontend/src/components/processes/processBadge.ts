// Производный бейдж процесса из статусов его участников (общий для рейла и прочих
// списков процессов). planned+deprecated → миграция, только planned → to-be,
// только deprecated → вывод, всё existing → бейджа нет. Вынесено из
// BusinessProcessSection при переезде списка процессов в рейл режима «Процессы».
import type { CSSProperties } from "react";
import type { NodeStatus } from "../../types";
import { getNodeColors } from "../graph/colors";
import { BPT, withAlpha } from "./tokens";

export type BadgeTone = "planned" | "deprecated" | "neutral";

export function processBadge(statuses: NodeStatus[]): { t: string; tone: BadgeTone } | null {
  const hasP = statuses.includes("planned");
  const hasD = statuses.includes("deprecated");
  if (hasP && hasD) return { t: "миграция", tone: "neutral" };
  if (hasP) return { t: "to-be", tone: "planned" };
  if (hasD) return { t: "вывод", tone: "deprecated" };
  return null;
}

// Тинт пилюли из статусной палитры (planned/deprecated) или нейтрали (миграция).
export function pillStyle(tone: BadgeTone): CSSProperties {
  const base: CSSProperties = {
    flex: "none",
    fontSize: 9.5,
    fontWeight: 700,
    letterSpacing: ".02em",
    padding: "1px 6px",
    borderRadius: 5,
    lineHeight: 1.4,
  };
  if (tone === "neutral") return { ...base, color: BPT.sec, background: BPT.line2, border: "1px solid " + BPT.line };
  const sc = getNodeColors(false, 0, tone);
  return { ...base, color: sc.border, background: withAlpha(sc.bg, 0.12), border: "1px solid " + withAlpha(sc.border, 0.4) };
}

// Падежи «сообщение/сообщения/сообщений» для счётчика.
export function pluralMessages(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "сообщение";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "сообщения";
  return "сообщений";
}
