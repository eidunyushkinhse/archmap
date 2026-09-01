// Настройка «Скрыть подписи связей» (тумблер холста, canvas.md CV32) — клиентский
// ВИЗУАЛЬНЫЙ слой: плашки и поводки прячутся CSS-классом на корне холста, раскладка
// и маршруты НЕ пересчитываются (плашки остаются участниками раскладки, поэтому
// переключение мгновенно и экран стабилен — аксиома P14).
// Персист — по образцу «Вида схемы» (schemaView.ts): свой ключ localStorage на
// проект. Настройка описывает КОНКРЕТНУЮ схему («эта — плотная, текст мешает»),
// а не привычку читателя вообще. Глобального семени, в отличие от вида, нет —
// настройка новая, наследовать нечего; дефолт — подписи видны.
import { getCurrentProjectId } from "../../api/projectScope";

const KEY = "archmap-hide-edge-labels";

function prefKey(projectId: string | null): string {
  return projectId ? `${KEY}:${projectId}` : KEY;
}

/** Прочитать настройку текущего проекта (дефолт — подписи видны). */
export function readEdgeLabelsHidden(): boolean {
  return localStorage.getItem(prefKey(getCurrentProjectId())) === "1";
}

/** Записать настройку текущего проекта (false стирает ключ — дефолт не хранится). */
export function writeEdgeLabelsHidden(hidden: boolean): void {
  const key = prefKey(getCurrentProjectId());
  if (hidden) localStorage.setItem(key, "1");
  else localStorage.removeItem(key);
}
