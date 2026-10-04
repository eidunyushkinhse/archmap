// Кнопка «?» рядом с меткой «Песочница» в шапках: запускает обучение заново
// (docs/tasks/demo-tour.md). Только гостю: гости бывают лишь на демо-стенде, а тур
// App монтирует ровно им (demo_mode и гость).
import type { CSSProperties } from "react";
import { getIsGuest } from "../../api/auth";
import { requestTourRestart } from "./tourStore";

export default function TourHelpButton() {
  if (!getIsGuest()) return null;
  return (
    <button
      type="button"
      style={btn}
      onClick={requestTourRestart}
      title="Пройти обучение заново"
      aria-label="Пройти обучение заново"
    >
      ?
    </button>
  );
}

// Пара к метке «Песочница» (ui/SandboxChip): та же янтарная гамма, круг по её высоте.
const btn: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", flex: "none",
  width: 29, height: 29, padding: 0, borderRadius: "50%", cursor: "pointer",
  fontSize: 14, fontWeight: 700, lineHeight: 1, fontFamily: "inherit",
  color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a",
};
