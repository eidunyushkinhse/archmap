// Тост внизу холста, когда добавление упирается в предел демо-стенда
// (docs/tasks/demo-mode.md, экран 4 прототипа): «Не получилось добавить объект.
// Демо-проект поддерживает до 100 объектов…». Для записей без своего окна: отмена
// и повтор удаления или создания, «Новый процесс», дубль процесса. Родитель —
// позиционированный контейнер холста.
import type { CSSProperties } from "react";
import type { LimitMessage } from "./demoLimits";

export default function DemoLimitToast({ message }: { message: LimitMessage | null }) {
  if (!message) return null;
  return (
    <div style={toast} role="status">
      <div><b style={{ color: "#fff" }}>{message.head}</b> {message.text}</div>
    </div>
  );
}

const toast: CSSProperties = {
  position: "absolute", left: "50%", bottom: 22, transform: "translateX(-50%)", zIndex: 7,
  width: "min(520px, calc(100% - 32px))", boxSizing: "border-box",
  display: "flex", gap: 12, alignItems: "flex-start",
  padding: "11px 16px", borderRadius: 10, background: "#1e293b", color: "#f8fafc",
  fontSize: 13.5, lineHeight: 1.45, boxShadow: "0 12px 30px rgba(15,23,42,.3)",
};

/** Текст отказа строкой с жирным началом — для окон, где ошибка показывается
 *  абзацем (окно «Новый объект», новая связь, импорт процесса). */
export function LimitText({ message }: { message: LimitMessage }) {
  return <><b>{message.head}</b> {message.text}</>;
}
