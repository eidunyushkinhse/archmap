// Кнопка «Обучение» в шапках гостя демо-стенда: запускает обучение заново
// (docs/tasks/demo-tour.md, -2.md). Стоит на месте аватара и меню профиля — выходить и
// менять пароль гостю незачем. Только гостю: гости бывают лишь на демо-стенде, а тур
// App монтирует ровно им (demo_mode и гость). Пока тур на паузе (клик по затемнению,
// docs/tasks/demo-tour-pause.md), кнопка — «Продолжить обучение»: тур ушёл в неё.
// Вид (редизайн, фазы 12б и 13а): в покое вторичная кнопка языка (ds-btn), на паузе — своя
// кнопка с мягкой подложкой акцента (tour.css): рядом в шапке редактора стоит главная «Готово».
import { useSyncExternalStore } from "react";
import { getIsGuest } from "../../api/auth";
import { getTourPaused, requestTourRestart, requestTourResume, subscribeTourPaused } from "./tourStore";
import "../../ui/ds.css";
import "./tour.css";

export default function TourHelpButton() {
  const paused = useSyncExternalStore(subscribeTourPaused, getTourPaused);
  if (!getIsGuest()) return null;
  // Ключи разные: тур ушёл на паузу — новая кнопка, её вспышка проигрывается заново.
  return paused ? (
    <button
      key="resume" type="button" className="ds-btn tour-pill--resume" data-tour-pill=""
      onClick={requestTourResume} title="Вернуться к шагу обучения"
    >
      Продолжить обучение
    </button>
  ) : (
    <button key="restart" type="button" className="ds-btn" data-tour-pill="" onClick={requestTourRestart} title="Пройти обучение заново">
      Обучение
    </button>
  );
}
