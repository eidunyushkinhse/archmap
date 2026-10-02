// Метка «Песочница» в шапке гостя демо-стенда (docs/tasks/demo-mode.md): стоит на
// месте аватара и меню профиля — выходить и менять пароль гостю незачем.
import type { CSSProperties } from "react";

export default function SandboxChip() {
  return <span style={chip}>Песочница</span>;
}

const chip: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px",
  fontSize: 12.5, fontWeight: 600, color: "#92400e", background: "#fffbeb",
  border: "1px solid #fde68a", borderRadius: 999, whiteSpace: "nowrap",
};
