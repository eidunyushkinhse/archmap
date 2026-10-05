// Плашки пределов демо-стенда в окнах ввоза (docs/tasks/demo-mode.md, экран 3
// прототипа): «Проект не помещается в демо» с полоской «142 из 100» и «Файл слишком
// большой для демо». Тексты — demoLimits.ts.
import type { CSSProperties } from "react";
import type { DemoExcess } from "../../types";
import { excessText, fileTooBigText, humanSize, kb, METER_LABEL } from "./demoLimits";
import type { ExcessScope, LimitMessage } from "./demoLimits";

/** Проект не помещается в пределы: плашка и полоска «142 из 100». */
export function DemoExcessNotice({ excess, scope }: { excess: DemoExcess; scope: ExcessScope }) {
  const value = excess.kind === "text"
    ? `${humanSize(excess.actual)} из ${kb(excess.limit)}`
    : `${excess.actual} из ${excess.limit}`;
  const fill = Math.min(100, Math.round((excess.actual / Math.max(1, excess.limit)) * 100));
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={errBox} role="alert">
        <b>Проект не помещается в демо.</b> {excessText(excess, scope)}
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <div style={meterLabel}>
          <span>{METER_LABEL[excess.kind]}</span>
          <span>{value}</span>
        </div>
        <div style={meterBar}><i style={{ ...meterFill, width: `${fill}%` }} /></div>
      </div>
    </div>
  );
}

export function FileTooBigNotice({ name, size, limit }: { name: string; size: number; limit: number }) {
  return (
    <div style={errBox} role="alert">
      <b>Файл слишком большой для демо.</b> {fileTooBigText(name, size, limit)}
    </div>
  );
}

// Цвета прототипа: красная плашка ошибки и красная полоска превышения.
const errBox: CSSProperties = {
  fontSize: 13.5, lineHeight: 1.45, borderRadius: 8, padding: "10px 12px",
  border: "1px solid #fecaca", background: "#fef2f2", color: "#b91c1c",
};
const meterLabel: CSSProperties = {
  display: "flex", justifyContent: "space-between", fontSize: 12.5, color: "#64748b",
  fontVariantNumeric: "tabular-nums",
};
const meterBar: CSSProperties = { height: 6, borderRadius: 3, background: "#eef2f6", overflow: "hidden" };
const meterFill: CSSProperties = { display: "block", height: "100%", background: "#dc2626" };

/** Отказ записи по пределу («Не сохранилось. Текста в проекте стало больше…») —
 *  плашкой в секциях страницы объекта (конфигурация, таблицы, каналы). */
export function LimitNotice({ message }: { message: LimitMessage }) {
  return (
    <div style={{ ...errBox, margin: "0 0 10px" }} role="alert">
      <b>{message.head}</b> {message.text}
    </div>
  );
}
