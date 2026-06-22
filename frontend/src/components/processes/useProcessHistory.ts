// Undo/Redo редактора процесса. Как на C4-канвасе, правки персистятся в Postgres
// сразу, поэтому undo — это не откат фронт-стейта, а КОМПЕНСИРУЮЩИЙ вызов API.
// Отличие от graph/useHistory: команды АСИНХРОННЫЕ (бьют API и ждут ответа), после
// каждого undo/redo перечитываем процесс целиком (reload). Пока вызов в полёте —
// busy=true (кнопки/клавиши заблокированы), чтобы команды не наезжали друг на друга.
//
// Воссоздание сущности при undo даёт НОВЫЙ id (у процессов нет restore-эндпоинта,
// сохраняющего id). Поэтому каждая команда держит id в замыкании и обновляет его на
// undo/redo, а парная операция бьёт по актуальному id — цепочка undo↔redo не рвётся.
import { useCallback, useRef, useState } from "react";

export interface AsyncCommand {
  label: string; // человекочитаемая метка (для будущих тостов)
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const MAX_HISTORY = 50; // потолок истории на сессию окна (как у graph/useHistory)

export interface ProcessHistory {
  // Зарегистрировать УЖЕ выполненное действие (forward сделал вызывающий) и его инверсию.
  push: (cmd: AsyncCommand) => void;
  undo: () => void;
  redo: () => void;
  clear: () => void;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
}

export function useProcessHistory(reload: () => void): ProcessHistory {
  // Стеки — источник правды в рефах (правятся только в колбэках, не в рендере).
  // canUndo/canRedo зеркалятся в state (читать ref в рендере нельзя — react-hooks/refs).
  const undoStack = useRef<AsyncCommand[]>([]);
  const redoStack = useRef<AsyncCommand[]>([]);
  const busyRef = useRef(false);
  const [flags, setFlags] = useState({ canUndo: false, canRedo: false });
  const [busy, setBusy] = useState(false);
  const sync = () =>
    setFlags({ canUndo: undoStack.current.length > 0, canRedo: redoStack.current.length > 0 });

  const push = useCallback((cmd: AsyncCommand) => {
    undoStack.current.push(cmd);
    if (undoStack.current.length > MAX_HISTORY) undoStack.current.shift();
    redoStack.current.length = 0;
    sync();
  }, []);

  const run = useCallback(
    async (from: AsyncCommand[], to: AsyncCommand[], apply: (c: AsyncCommand) => Promise<void>) => {
      const cmd = from[from.length - 1];
      if (!cmd || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      try {
        await apply(cmd);
        from.pop();
        to.push(cmd);
        reload();
      } finally {
        busyRef.current = false;
        setBusy(false);
        sync();
      }
    },
    [reload],
  );

  const undo = useCallback(() => {
    void run(undoStack.current, redoStack.current, (c) => c.undo());
  }, [run]);
  const redo = useCallback(() => {
    void run(redoStack.current, undoStack.current, (c) => c.redo());
  }, [run]);

  const clear = useCallback(() => {
    undoStack.current = [];
    redoStack.current = [];
    sync();
  }, []);

  return { push, undo, redo, clear, canUndo: flags.canUndo, canRedo: flags.canRedo, busy };
}
