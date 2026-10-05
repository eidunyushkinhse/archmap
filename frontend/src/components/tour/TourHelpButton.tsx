// Пилюля «Обучение» в шапках гостя демо-стенда: запускает обучение заново
// (docs/tasks/demo-tour.md, -2.md). Стоит на месте аватара и меню профиля — выходить и
// менять пароль гостю незачем. Только гостю: гости бывают лишь на демо-стенде, а тур
// App монтирует ровно им (demo_mode и гость).
import type { CSSProperties } from "react";
import { getIsGuest } from "../../api/auth";
import { requestTourRestart } from "./tourStore";

export default function TourHelpButton() {
  if (!getIsGuest()) return null;
  return (
    <button type="button" style={pill} onClick={requestTourRestart} title="Пройти обучение заново">
      Обучение
    </button>
  );
}

// Янтарная пилюля демо-стенда (та же гамма, что у плашки «Это песочница…»).
const pill: CSSProperties = {
  display: "inline-flex", alignItems: "center", flex: "none", padding: "5px 12px",
  fontSize: 12.5, fontWeight: 600, lineHeight: 1.2, fontFamily: "inherit", whiteSpace: "nowrap",
  color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 999,
  cursor: "pointer",
};
