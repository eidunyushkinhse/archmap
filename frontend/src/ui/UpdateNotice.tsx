import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { primaryBtn } from "./styles";

// Плашка «вышла новая версия» (аудит R-7). После выката старые чанки сборки пропадают
// с сервера, и открытая вкладка не может догрузить ленивые части (mermaid, swagger,
// окна): Vite сообщает об этом событием vite:preloadError. Перезагружать страницу
// сами не станем — в открытом окне может быть несохранённая правка; говорим человеку
// и даём кнопку. Ошибку не гасим (preventDefault не зовём): загрузчик сам покажет,
// что его часть не загрузилась.
export const UPDATE_NOTICE = "Вышла новая версия ArchMap — обновите страницу, чтобы всё загружалось.";

export default function UpdateNotice() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const onPreloadError = () => setStale(true);
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => window.removeEventListener("vite:preloadError", onPreloadError);
  }, []);

  if (!stale) return null;
  return (
    <div role="status" style={bar}>
      <span>{UPDATE_NOTICE}</span>
      <button type="button" style={primaryBtn} onClick={() => window.location.reload()}>
        Обновить
      </button>
    </div>
  );
}

const bar: CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: 16,
  transform: "translateX(-50%)",
  zIndex: 10000,
  display: "flex",
  alignItems: "center",
  gap: 12,
  maxWidth: "calc(100% - 32px)",
  padding: "10px 12px 10px 16px",
  background: "#1e293b",
  color: "#f8fafc",
  borderRadius: 10,
  boxShadow: "0 12px 32px rgba(15,23,42,.25)",
  fontSize: 14,
};
