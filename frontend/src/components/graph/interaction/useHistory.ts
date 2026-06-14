// Движок Undo/Redo для канваса уровня. Правки персистятся в Postgres сразу, поэтому
// undo — это не откат фронт-стейта, а КОМПЕНСИРУЮЩИЙ вызов API. Моделируем каждое
// действие как обратимую команду {undo, redo}: undo/redo синхронно зеркалят правку в
// локальный стейт (мгновенно) и фоном бьют API — тот же контракт, что у самих мутаций
// (см. persistGroup). Два стека, лимит, в памяти вкладки. Только архитектор (команды
// кладутся лишь на реально персистнутых правках; в контексте мутаций нет → стек пуст).
import { useState } from "react";

export interface HistoryCommand {
  // человекочитаемая метка действия (для будущих тостов/индикатора)
  label: string;
  // Уровень (containerId), на котором сделано изменение; null = корень. Нужен для
  // кросс-уровневого Undo: перед откатом TreePage редиректит пользователя на этот
  // уровень, если он открыт другой (зеркало правки садится на загруженные данные
  // уровня). Команды основного канваса штампуются текущим containerId, структурные
  // (TreePage) — уровнем, где произошла правка. undefined трактуется как «текущий».
  level?: string | null;
  // вернуть состояние «как было до действия»
  undo: () => void;
  // повторно применить действие
  redo: () => void;
}

export interface History {
  push: (cmd: HistoryCommand) => void;
  undo: () => boolean;
  redo: () => boolean;
  // Верхняя команда соответствующего стека БЕЗ её выполнения — чтобы дисптчер успел
  // увести пользователя на нужный уровень до того, как сработает undo/redo.
  peekUndo: () => HistoryCommand | undefined;
  peekRedo: () => HistoryCommand | undefined;
  clear: () => void;
}

// Потолок истории на сессию вкладки (ориентир из обсуждения — 30–50 шагов).
const MAX_HISTORY = 50;

// Чистая фабрика (без React) — вся логика стеков, под юнит-тестами. React-обёртка ниже
// просто держит одну стабильную инстанцию на время жизни компонента.
export function createHistory(): History {
  const undoStack: HistoryCommand[] = [];
  const redoStack: HistoryCommand[] = [];

  return {
    // Новое действие кладётся в undo-стек и ОБРЫВАЕТ ветку redo (как в любом редакторе).
    push(cmd) {
      undoStack.push(cmd);
      // лимит: самые старые шаги вытесняются снизу
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack.length = 0;
    },
    // Откат последнего действия. Возвращает false, если откатывать нечего.
    undo() {
      const cmd = undoStack.pop();
      if (!cmd) return false;
      cmd.undo();
      redoStack.push(cmd);
      return true;
    },
    // Повтор последнего отменённого действия. false, если повторять нечего.
    redo() {
      const cmd = redoStack.pop();
      if (!cmd) return false;
      cmd.redo();
      undoStack.push(cmd);
      return true;
    },
    peekUndo() {
      return undoStack[undoStack.length - 1];
    },
    peekRedo() {
      return redoStack[redoStack.length - 1];
    },
    // Сброс истории (например, при логауте). NB: при навигации между уровнями НЕ
    // чистим — история теперь сквозная, кросс-уровневый Undo редиректит на нужный уровень.
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
}

// React-обёртка: одна стабильная инстанция истории на время жизни компонента, её методы
// стабильны по ссылке (можно класть в зависимости хуков без ререндер-каскада).
export function useHistory(): History {
  // Ленивый инициализатор useState — одна инстанция на всё время жизни компонента
  // (createHistory вызовется ровно раз), методы стабильны по ссылке.
  const [history] = useState(createHistory);
  return history;
}
