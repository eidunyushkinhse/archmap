// Точка входа живой схемы лендинга (embed.html → npm run build:embed). Статический
// бэкенд ставится до монтирования: первый же запрос холста уходит уже к нему.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import LandingSchema from "./LandingSchema";
import { installStaticBackend } from "./staticBackend";
import { SCENE } from "./scene.gen";
import "./embed.css";

installStaticBackend(SCENE);

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Корневой элемент #root не найден в DOM");

createRoot(rootEl).render(
  <StrictMode>
    <LandingSchema scene={SCENE} />
  </StrictMode>,
);
