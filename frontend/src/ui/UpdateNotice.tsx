import { useEffect, useState } from "react";
import "./ds.css";

// Плашка «вышла новая версия» (аудит R-7). После выката старые чанки сборки пропадают
// с сервера, и открытая вкладка не может догрузить ленивые части (mermaid, swagger,
// окна): Vite сообщает об этом событием vite:preloadError. Перезагружать страницу
// сами не станем — в открытом окне может быть несохранённая правка; говорим человеку
// и даём кнопку. Ошибку не гасим (preventDefault не зовём): загрузчик сам покажет,
// что его часть не загрузилась. Вид — тост нового языка с кнопкой, внизу окна поверх
// всего (ui/ds.css).
export const UPDATE_NOTICE = "Вышла новая версия ArchMap. Обновите страницу, чтобы всё загружалось.";

export default function UpdateNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const onPreloadError = () => setStale(true);
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => window.removeEventListener("vite:preloadError", onPreloadError);
  }, []);

  if (!stale) return null;
  return (
    <div role="status" className="ds-toast ds-toast--action ds-toast--service-bottom">
      <span>{UPDATE_NOTICE}</span>
      <button type="button" className="ds-btn" onClick={() => window.location.reload()}>
        Обновить
      </button>
    </div>
  );
}
