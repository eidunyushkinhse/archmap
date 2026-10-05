// Пилюля «Обучение» в шапках гостя демо-стенда: запускает обучение заново
// (docs/tasks/demo-tour.md, -2.md). Стоит на месте аватара и меню профиля — выходить и
// менять пароль гостю незачем. Только гостю: гости бывают лишь на демо-стенде, а тур
// App монтирует ровно им (demo_mode и гость). Пока тур на паузе (клик по затемнению,
// docs/tasks/demo-tour-pause.md), пилюля — «Продолжить обучение»: тур ушёл в неё.
import { useSyncExternalStore, type CSSProperties } from "react";
import { getIsGuest } from "../../api/auth";
import { getTourPaused, requestTourRestart, requestTourResume, subscribeTourPaused } from "./tourStore";
import "./tour.css";

export default function TourHelpButton() {
  const paused = useSyncExternalStore(subscribeTourPaused, getTourPaused);
  if (!getIsGuest()) return null;
  // Ключи разные: тур ушёл на паузу — новая пилюля, её вспышка проигрывается заново.
  return paused ? (
    <button
      key="resume" type="button" className="tour-pill--resume" style={pill} data-tour-pill=""
      onClick={requestTourResume} title="Вернуться к шагу обучения"
    >
      Продолжить обучение
    </button>
  ) : (
    <button key="restart" type="button" style={pill} data-tour-pill="" onClick={requestTourRestart} title="Пройти обучение заново">
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
