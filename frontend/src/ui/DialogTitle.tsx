import type { CSSProperties, ReactNode } from "react";

// Заголовок окна и подзаголовок под ним — один вид во всех простых диалогах (аудит F-20,
// решение владельца 2026-10-15; прежде 17 и 18 px с разными отступами). Эталон — окна
// пользователей: 18 px; без подзаголовка до содержимого 16 px, с подзаголовком — 10 px
// до него и 16 px после. Компонент, а не проп Modal: у окон с несколькими видами
// (загрузка, отказ, итог) заголовок свой в каждой ветке.
export default function DialogTitle({ children, lead }: { children: ReactNode; lead?: ReactNode }) {
  return (
    <>
      <h3 style={lead != null ? titleWithLead : title}>{children}</h3>
      {lead != null && <p style={leadStyle}>{lead}</p>}
    </>
  );
}

const title: CSSProperties = { margin: "0 0 16px", fontSize: 18, fontWeight: 700, color: "#0f172a" };
const titleWithLead: CSSProperties = { ...title, margin: "0 0 10px" };
const leadStyle: CSSProperties = { margin: "0 0 16px", fontSize: 14, color: "#475569", lineHeight: 1.5 };
