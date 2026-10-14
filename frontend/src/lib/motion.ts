// Пользователь просит без анимаций (системная настройка). Общая проверка для тура и
// превью схемы на странице входа (аудит F-25: было двумя копиями).
export function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
