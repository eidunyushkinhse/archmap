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
  // Есть ли что отменять/повторять — для disabled-состояния кнопок тулбара. Предикаты
  // читаются на рендере; стек меняется вместе с правкой стейта (push/undo/redo зовут
  // setState), поэтому кнопки пересчитываются естественным ререндером.
  canUndo: () => boolean;
  canRedo: () => boolean;
  // Сгруппировать все push-и одного жеста в ОДНУ составную команду. Между beginGroup и
  // commitGroup каждый push не кладётся в стек, а буферизуется; commitGroup сворачивает
  // буфер в один HistoryCommand (undo откатывает всё в обратном порядке, redo повторяет
  // в прямом). Так мультидраг с переносом изломов = один шаг Undo, а не 1+N. Группа в
  // одну команду → один push → ветка redo обрывается один раз, лимит считает её за шаг.
  beginGroup: () => void;
  commitGroup: (label?: string) => void;
  clear: () => void;
}

// Потолок истории на сессию вкладки (ориентир из обсуждения — 30–50 шагов).
const MAX_HISTORY = 50;

// Чистая фабрика (без React) — вся логика стеков, под юнит-тестами. React-обёртка ниже
// просто держит одну стабильную инстанцию на время жизни компонента.
export function createHistory(): History {
  const undoStack: HistoryCommand[] = [];
  const redoStack: HistoryCommand[] = [];
  // Активный буфер группировки жеста (см. beginGroup/commitGroup). null = пишем сразу.
  let group: HistoryCommand[] | null = null;

  // Положить готовую команду в undo-стек: обрывает ветку redo (как в любом редакторе),
  // вытесняет самые старые шаги по лимиту. Единая точка — её зовут push и commitGroup.
  const commit = (cmd: HistoryCommand) => {
    undoStack.push(cmd);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack.length = 0;
  };

  return {
    // Новое действие. Внутри группы — буферизуем; иначе сразу в undo-стек.
    push(cmd) {
      if (group) group.push(cmd);
      else commit(cmd);
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
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    // Открыть буфер группировки. Повторный beginGroup без commit продолжает текущий
    // буфер (вложенность не моделируем — жест всегда плоский).
    beginGroup() {
      group ??= [];
    },
    // Закрыть буфер и свернуть его в стек. Пустой буфер — ничего. Ровно один push —
    // кладём команду как есть (сохраняя её label/level, без лишней обёртки). Несколько —
    // составная команда: undo прокручивает буфер в обратном порядке, redo — в прямом.
    // level берём из первой команды (весь жест — на одном уровне).
    commitGroup(label) {
      const cmds = group;
      group = null;
      if (!cmds || cmds.length === 0) return;
      if (cmds.length === 1) {
        commit(cmds[0]);
        return;
      }
      commit({
        label: label ?? cmds[cmds.length - 1].label,
        level: cmds[0].level,
        undo: () => {
          for (let i = cmds.length - 1; i >= 0; i--) cmds[i].undo();
        },
        redo: () => {
          for (const c of cmds) c.redo();
        },
      });
    },
    // Сброс истории (например, при логауте). NB: при навигации между уровнями НЕ
    // чистим — история теперь сквозная, кросс-уровневый Undo редиректит на нужный уровень.
    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
      group = null;
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
