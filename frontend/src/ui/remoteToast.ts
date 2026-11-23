import type { CSSProperties } from "react";

// Тост «Схему только что изменили в другом окне» в колонке редактора-карты (поллинг
// конкурентных сессий, useRemoteSync), прежнего вида до перевода колонки. На главной
// проекта и на странице объекта он уже тост нового языка (ui/ds.css, ds-toast--corner).
const look: CSSProperties = {
  background: "#eef2ff",
  border: "1px solid #c7d2fe",
  color: "#3730a3",
  borderRadius: 10,
  padding: "7px 12px",
  fontSize: 13,
  boxShadow: "0 4px 12px rgba(30,41,59,.10)",
};

// В колонке тостов редактора-карты: место задаёт колонка, клики проходят только по тосту.
export const remoteToastInRail: CSSProperties = { ...look, pointerEvents: "auto" };
