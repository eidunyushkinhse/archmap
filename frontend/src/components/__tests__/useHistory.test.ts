import { describe, it, expect } from "vitest";
import { createHistory, type HistoryCommand } from "../graph/interaction/useHistory";

// Движок Undo/Redo: стеки команд. Проверяем базовый цикл undo/redo, обрыв redo новым
// действием, пустые стеки и вытеснение по лимиту (50).

// Команда-«счётчик»: пишет в журнал, какие undo/redo вызвались — так видно порядок.
function cmd(log: string[], name: string): HistoryCommand {
  return {
    label: name,
    undo: () => log.push(`undo:${name}`),
    redo: () => log.push(`redo:${name}`),
  };
}

describe("createHistory", () => {
  it("undo/redo пустых стеков возвращают false и ничего не делают", () => {
    const h = createHistory();
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(false);
  });

  it("undo откатывает последнее действие, redo повторяет его", () => {
    const log: string[] = [];
    const h = createHistory();
    h.push(cmd(log, "A"));
    h.push(cmd(log, "B"));

    expect(h.undo()).toBe(true); // откат B
    expect(h.undo()).toBe(true); // откат A
    expect(h.undo()).toBe(false); // больше нечего
    expect(log).toEqual(["undo:B", "undo:A"]);

    expect(h.redo()).toBe(true); // повтор A
    expect(h.redo()).toBe(true); // повтор B
    expect(h.redo()).toBe(false);
    expect(log).toEqual(["undo:B", "undo:A", "redo:A", "redo:B"]);
  });

  it("новое действие после undo обрывает ветку redo", () => {
    const log: string[] = [];
    const h = createHistory();
    h.push(cmd(log, "A"));
    h.push(cmd(log, "B"));
    h.undo(); // откат B → B в redo-стеке
    h.push(cmd(log, "C")); // новое действие чистит redo

    expect(h.redo()).toBe(false); // B больше не повторить
    expect(h.undo()).toBe(true); // откат C
    expect(h.undo()).toBe(true); // откат A
    expect(log).toEqual(["undo:B", "undo:C", "undo:A"]);
  });

  it("clear опустошает обе ветки", () => {
    const h = createHistory();
    h.push(cmd([], "A"));
    h.undo();
    h.clear();
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(false);
  });

  it("peekUndo/peekRedo возвращают верхнюю команду НЕ выполняя её (с level)", () => {
    const log: string[] = [];
    const h = createHistory();
    expect(h.peekUndo()).toBeUndefined();
    expect(h.peekRedo()).toBeUndefined();

    h.push({ ...cmd(log, "A"), level: "lvl-1" });
    // peek не трогает стек и не вызывает undo/redo
    expect(h.peekUndo()?.label).toBe("A");
    expect(h.peekUndo()?.level).toBe("lvl-1");
    expect(log).toEqual([]);

    h.undo(); // A ушла в redo-стек
    expect(h.peekUndo()).toBeUndefined();
    expect(h.peekRedo()?.label).toBe("A");
    expect(h.peekRedo()?.level).toBe("lvl-1");
    expect(log).toEqual(["undo:A"]);
  });

  it("beginGroup/commitGroup сворачивают жест в одну команду (undo обратный порядок)", () => {
    const log: string[] = [];
    const h = createHistory();
    h.beginGroup();
    h.push({ ...cmd(log, "wp1"), level: "lvl-1" });
    h.push({ ...cmd(log, "wp2"), level: "lvl-1" });
    h.push({ ...cmd(log, "move"), level: "lvl-1" });
    h.commitGroup("Перемещение группы");

    // вся группа — одна вершина undo-стека с переданной меткой и level из первой команды
    expect(h.peekUndo()?.label).toBe("Перемещение группы");
    expect(h.peekUndo()?.level).toBe("lvl-1");

    // один undo откатывает весь жест в обратном порядке…
    expect(h.undo()).toBe(true);
    expect(h.undo()).toBe(false); // больше ничего — это был один шаг
    expect(log).toEqual(["undo:move", "undo:wp2", "undo:wp1"]);

    // …а один redo повторяет его в прямом
    expect(h.redo()).toBe(true);
    expect(h.redo()).toBe(false);
    expect(log).toEqual(["undo:move", "undo:wp2", "undo:wp1", "redo:wp1", "redo:wp2", "redo:move"]);
  });

  it("commitGroup с одной командой кладёт её как есть, пустую группу игнорирует", () => {
    const log: string[] = [];
    const h = createHistory();
    // пустой жест (клик без движения) не создаёт шага
    h.beginGroup();
    h.commitGroup();
    expect(h.peekUndo()).toBeUndefined();

    // одиночная команда сохраняет свою метку, без обёртки "группы"
    h.beginGroup();
    h.push({ ...cmd(log, "single"), level: "x" });
    h.commitGroup("Перемещение группы");
    expect(h.peekUndo()?.label).toBe("single");
    h.undo();
    expect(log).toEqual(["undo:single"]);
  });

  it("лимит 50: самые старые шаги вытесняются", () => {
    const log: string[] = [];
    const h = createHistory();
    // 60 действий — в стеке должны остаться последние 50 (10..59)
    for (let i = 0; i < 60; i++) h.push(cmd(log, String(i)));

    let undone = 0;
    while (h.undo()) undone++;
    expect(undone).toBe(50);
    // первым откатился самый свежий (59), последним — самый старый из оставшихся (10)
    expect(log[0]).toBe("undo:59");
    expect(log[log.length - 1]).toBe("undo:10");
  });
});
