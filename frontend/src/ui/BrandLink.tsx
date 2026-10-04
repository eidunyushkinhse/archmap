// Логотип и название ArchMap в левом верхнем углу. С onClick — кнопка, ведущая на
// экран «Все проекты» (оболочка проекта и редактор); без него — просто знак (сам
// экран «Все проекты»: вести некуда).
import type { CSSProperties } from "react";
import { LogoMark } from "./icons";

export default function BrandLink({ onClick }: { onClick?: () => void }) {
  const inner = (
    <>
      <LogoMark />
      <span style={word}>
        Arch<span style={{ color: "#2563eb" }}>Map</span>
      </span>
    </>
  );
  if (!onClick) return <div style={row}>{inner}</div>;
  return (
    <button type="button" className="brand-link" data-tour="logo" style={btn} onClick={onClick} title="Все проекты" aria-label="Все проекты">
      {inner}
    </button>
  );
}

const row: CSSProperties = { display: "flex", alignItems: "center", gap: 9 };
const btn: CSSProperties = {
  ...row, padding: "3px 6px", margin: "-3px -6px", border: "none", borderRadius: 8,
  cursor: "pointer", font: "inherit", // фон — в .brand-link (chrome.css), иначе :hover не сработает
};
const word: CSSProperties = { fontSize: 16.5, fontWeight: 700, letterSpacing: "-0.01em", color: "#0f172a" };
