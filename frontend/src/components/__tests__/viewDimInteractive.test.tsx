// Фильтр «Вид схемы» на диаграмме процесса ГАСИТ, но не отбирает управление.
//
// П4 челленджа дизайна (2026-08-16): приглушённые шаги получали pointerEvents "none"
// и выпадали из драга. Человек с видом «Как есть» в процессе с участником-planned не
// мог ни открыть шаг, ни переставить его, ни убрать участника — и без единого
// объяснения, почему клик не проходит. В процессе шаг — единственное место, где живут
// его подпись, тип канала и починка, так что глухой шаг делает процесс
// нередактируемым; поэтому гашение оставлено чисто визуальным.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SequenceDiagram from "../processes/SequenceDiagram";
import type { SeqMessage, SeqParticipant } from "../processes/sequence/layout";
import type { NodeStatus } from "../../types";

const part = (id: string, name: string, status: NodeStatus): SeqParticipant => ({
  id, nodeId: "node-" + id, name, role: "сервис", shape: "service", external: false, status,
});

const M = (id: string, r: number, from: string, to: string): SeqMessage =>
  ({ id, r, n: r + 1, from, to, kind: "forward", label: "шаг " + (r + 1), tech: null, valid: true }) as SeqMessage;

// Вид «Как есть» прячет planned: участник «Биллинг» и шаг к нему приглушены.
function renderDimmed(over: {
  onMessageClick?: (id: string) => void;
  onDeleteParticipant?: (id: string) => void;
  onReorderMessages?: (ids: string[]) => void;
} = {}) {
  const participants = [part("a", "Клиент", "existing"), part("b", "Биллинг", "planned")];
  return render(
    <SequenceDiagram
      participants={participants}
      messages={[M("m0", 0, "a", "b")]}
      view="asis"
      ghost
      {...over}
    />,
  );
}

const label = (c: HTMLElement) => c.querySelector('[data-mid="m0"]') as HTMLElement;
// Невидимая полоса захвата поверх стрелки: ею шаг и берут курсором.
const grabStripes = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("line")).filter((l) => l.getAttribute("stroke") === "transparent");

describe("приглушённые видом шаги остаются рабочими", () => {
  it("шаг вне вида всё ещё приглушён — гашение не потеряно", () => {
    const { container } = renderDimmed({ onMessageClick: vi.fn() });
    expect(label(container).style.opacity).toBe("0.12");
  });

  it("клик по приглушённому шагу открывает его карточку", async () => {
    const onMessageClick = vi.fn();
    const { container } = renderDimmed({ onMessageClick });

    // userEvent честно проверяет pointer-events: при "none" клик не пройдёт вовсе.
    await userEvent.click(label(container));

    expect(onMessageClick).toHaveBeenCalledWith("m0");
  });

  it("приглушённый шаг берётся драгом — полоса захвата на месте", () => {
    const { container } = renderDimmed({ onReorderMessages: vi.fn(), onMessageClick: vi.fn() });
    expect(grabStripes(container)).toHaveLength(1);
  });

  it("участника вне вида по-прежнему можно убрать из процесса", async () => {
    // Крестик живёт ВНУТРИ приглушённой шапки: pointerEvents "none" на ней глушил и его.
    const onDeleteParticipant = vi.fn();
    renderDimmed({ onDeleteParticipant });

    await userEvent.click(screen.getByRole("button", { name: "Удалить «Биллинг» из процесса" }));

    expect(onDeleteParticipant).toHaveBeenCalledWith("b");
  });
});
