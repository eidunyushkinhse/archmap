// Оконный хром окна процесса (шапка + тело + футер), портирован из дизайн-референса
// (bp-parts.jsx WindowChrome). Рендерится ВНУТРИ ui/Modal (нативный dialog даёт
// top-layer, Escape, фокус); сам Modal — с closeButton={false}, крестик тут свой.
import type { CSSProperties, ReactNode } from "react";
import { IcoFlow } from "./icons";
import { BPT } from "./tokens";

interface Props {
  title: string;
  scope?: string | null;
  actions?: ReactNode;
  foot?: ReactNode;
  width: number;
  height: number | string;
  children: ReactNode;
}

export default function ProcessWindow({ title, scope, actions, foot, width, height, children }: Props) {
  return (
    <div className="bp" style={{ ...shell, width, height }}>
      <div style={head}>
        <span style={glyph}>
          <IcoFlow s={16} />
        </span>
        <div style={{ fontSize: 15, fontWeight: 700, color: BPT.head, lineHeight: 1.2 }}>{title}</div>
        {scope && (
          <span style={scopeChip}>
            <span style={{ color: BPT.mut, fontSize: 11 }}>область</span>
            <b style={{ fontWeight: 600, color: BPT.head }}>{scope}</b>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "none" }}>{actions}</div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative", display: "flex", flexDirection: "column" }}>
        {children}
      </div>
      {foot && <div style={footer}>{foot}</div>}
    </div>
  );
}

const shell: CSSProperties = {
  maxWidth: "calc(100vw - 32px)",
  maxHeight: "90vh",
  background: "#fff",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
};
const head: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 11,
  padding: "0 12px 0 16px",
  height: 52,
  borderBottom: "1px solid " + BPT.line,
  flex: "none",
};
const glyph: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  background: BPT.wash,
  color: BPT.accent,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "none",
};
const scopeChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  marginLeft: 4,
  padding: "3px 9px",
  background: "#f8fafc",
  border: "1px solid " + BPT.line,
  borderRadius: 20,
  fontSize: 12,
  color: BPT.sec,
  flex: "none",
};
const footer: CSSProperties = {
  flex: "none",
  borderTop: "1px solid " + BPT.line,
  padding: "9px 16px",
  display: "flex",
  alignItems: "center",
  gap: 14,
  background: "#fcfdfe",
};
