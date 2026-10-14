// История Undo/Redo холста уровня (Ctrl+Z / Ctrl+Shift+Z, Ctrl+Y). Вынесено из
// LevelGraph (аудит F-1): адаптер истории, штампующий команды уровнем, запуск отмены и
// повтора и глобальные клавиши.
//
// На основном канвасе историю поднимают в страницу-хозяин (туда же кладутся
// структурные команды и дисптчеры с кросс-уровневым редиректом); собственная — фолбэк
// для страниц (EmbeddedSchemaBlock), где истории не нужно.
import { useEffect, useMemo } from "react";
import { useHistory } from "./useHistory";
import type { History } from "./useHistory";

export function useLevelHistory({
  historyProp, onUndo, onRedo, containerId, noteGesture, keysEnabled,
}: {
  historyProp?: History;
  // Дисптчеры страницы-хозяина (кросс-уровневый редирект); нет — своя история.
  onUndo?: () => void;
  onRedo?: () => void;
  containerId: string | null;
  // Undo/Redo — ручной жест: изменённые пересчётом стрелки перерисовываются анимированно.
  noteGesture: () => void;
  // Клавиши — только архитектору и не в контексте (read-only).
  keysEnabled: boolean;
}): { history: History; runUndo: () => void; runRedo: () => void } {
  const ownHistory = useHistory();
  const baseHistory = historyProp ?? ownHistory;
  // Команды этого канваса (перемещения) ШТАМПУЕМ текущим containerId, чтобы
  // кросс-уровневый Undo знал, на какой уровень вернуть пользователя перед откатом.
  // Адаптер оборачивает только push; остальные методы — как есть.
  const history = useMemo<History>(
    () => ({
      ...baseHistory,
      push: (cmd) => baseHistory.push({ ...cmd, level: containerId ?? null }),
    }),
    [baseHistory, containerId],
  );
  // Клавиши/кнопки зовут дисптчеры из MapEditorPage (кросс-уровневый редирект). В
  // контекст-модалке дисптчеров нет — там Undo/Redo и так не показываются. Мемоизируем,
  // чтобы не пересоздавать слушатель клавиш на каждый рендер.
  const runUndo = useMemo(
    () => () => { noteGesture(); (onUndo ?? history.undo)(); },
    [onUndo, history, noteGesture],
  );
  const runRedo = useMemo(
    () => () => { noteGesture(); (onRedo ?? history.redo)(); },
    [onRedo, history, noteGesture],
  );

  // Клавиши Undo/Redo — ГЛОБАЛЬНО на window (не через onKeyDown канваса): у .lg-canvas
  // нет tabIndex, поэтому его onKeyDown срабатывает лишь при фокусе внутри холста, а
  // Ctrl+Z жмут и без выбранного узла (фокус на body). В полях ввода не перехватываем —
  // там нативная отмена текста.
  useEffect(() => {
    if (!keysEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = document.activeElement as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) { e.preventDefault(); runUndo(); }
      else if ((key === "z" && e.shiftKey) || key === "y") { e.preventDefault(); runRedo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [keysEnabled, runUndo, runRedo]);

  return { history, runUndo, runRedo };
}
