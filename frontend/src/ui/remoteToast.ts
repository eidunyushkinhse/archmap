import type { CSSProperties } from "react";

// Тост «Схема обновлена в другой сессии» (поллинг конкурентных сессий, useRemoteSync):
// один вид на главной проекта, на странице объекта и в редакторе-карте. Синие тона —
// сообщение, а не ошибка (красный тост редактора) и не итог действия (зелёный).
const look: CSSProperties = {
  background: "#eef2ff",
  border: "1px solid #c7d2fe",
  color: "#3730a3",
  borderRadius: 10,
  padding: "7px 12px",
  fontSize: 13,
  boxShadow: "0 4px 12px rgba(30,41,59,.10)",
};

// Сам по себе в правом верхнем углу блока схемы (у родителя position: relative).
export const remoteToastStyle: CSSProperties = { position: "absolute", top: 12, right: 12, zIndex: 6, ...look };

// В колонке тостов редактора-карты: место задаёт колонка, клики проходят только по тосту.
export const remoteToastInRail: CSSProperties = { ...look, pointerEvents: "auto" };
