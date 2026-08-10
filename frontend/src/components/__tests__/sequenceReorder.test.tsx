// Перетаскивание шагов сценария: ручкой служит И подпись, И сама стрелка.
//
// Стрелку добавили по приёмке 2026-08-10: пользователь инстинктивно берётся за
// неё, а не за текст. Линия тонкая (1.7px), поэтому поверх лежит невидимая
// полоса захвата — тест ходит именно через неё, как курсор.
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SequenceDiagram from "../processes/SequenceDiagram";
import type { SeqMessage, SeqParticipant } from "../processes/sequence/layout";

const P = (id: string): SeqParticipant =>
  ({ id, name: id.toUpperCase(), shape: "service", external: false, status: "existing", role: null }) as SeqParticipant;

const M = (id: string, r: number): SeqMessage =>
  ({ id, r, from: "a", to: "b", kind: "call", valid: true, caption: id }) as unknown as SeqMessage;

function renderDiagram(onReorderMessages?: (ids: string[]) => void) {
  return render(
    <SequenceDiagram
      participants={[P("a"), P("b")]}
      messages={[M("m0", 0), M("m1", 1), M("m2", 2)]}
      ghost
      onReorderMessages={onReorderMessages}
    />,
  );
}

// Невидимые полосы захвата: единственные линии с прозрачной обводкой.
const grabStrips = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("line")).filter((l) => l.getAttribute("stroke") === "transparent");

describe("перетаскивание шага за стрелку", () => {
  it("над стрелкой есть полоса захвата у каждого сообщения", () => {
    const { container } = renderDiagram(vi.fn());
    expect(grabStrips(container)).toHaveLength(3);
  });

  it("без обработчика перестановки полос захвата нет", () => {
    const { container } = renderDiagram(undefined);
    expect(grabStrips(container)).toHaveLength(0);
  });

  it("протаскивание стрелки вверх отдаёт новый порядок", () => {
    const onReorder = vi.fn();
    const { container } = renderDiagram(onReorder);
    const third = grabStrips(container)[2]; // стрелка нижнего шага (m2)

    fireEvent.pointerDown(third, { clientY: 400 });
    fireEvent.pointerMove(container.firstChild!, { clientY: 60 }); // выше порога → драг
    fireEvent.pointerUp(container.firstChild!);

    expect(onReorder).toHaveBeenCalledTimes(1);
    const order = onReorder.mock.calls[0][0] as string[];
    expect(order).toHaveLength(3);
    expect(order[0]).toBe("m2"); // уехал наверх
  });

  it("сдвиг в пределах порога порядок не меняет", () => {
    // Иначе случайное дрожание руки при клике переставляло бы шаги.
    const onReorder = vi.fn();
    const { container } = renderDiagram(onReorder);
    const first = grabStrips(container)[0];

    fireEvent.pointerDown(first, { clientY: 100 });
    fireEvent.pointerMove(container.firstChild!, { clientY: 102 });
    fireEvent.pointerUp(container.firstChild!);

    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe("клик по стрелке равен клику по подписи", () => {
  it("клик по стрелке дёргает onMessageClick с её id", () => {
    // Раньше стрелка не делала ничего: одна сущность вела себя по-разному в
    // зависимости от того, куда попал курсор.
    const onMessageClick = vi.fn();
    const { container } = render(
      <SequenceDiagram
        participants={[P("a"), P("b")]}
        messages={[M("m0", 0), M("m1", 1)]}
        ghost
        onMessageClick={onMessageClick}
      />,
    );

    fireEvent.click(grabStrips(container)[1]);

    expect(onMessageClick).toHaveBeenCalledWith("m1");
  });

  it("после перетаскивания клик гасится", () => {
    // Иначе каждая перестановка заканчивалась бы окном «Удалить сообщение?».
    const onMessageClick = vi.fn();
    const { container } = render(
      <SequenceDiagram
        participants={[P("a"), P("b")]}
        messages={[M("m0", 0), M("m1", 1), M("m2", 2)]}
        ghost
        onMessageClick={onMessageClick}
        onReorderMessages={vi.fn()}
      />,
    );
    const strip = grabStrips(container)[2];

    fireEvent.pointerDown(strip, { clientY: 400 });
    fireEvent.pointerMove(container.firstChild!, { clientY: 60 });
    fireEvent.pointerUp(container.firstChild!);
    fireEvent.click(strip); // браузер шлёт его следом за pointerup

    expect(onMessageClick).not.toHaveBeenCalled();
  });

  it("стрелка кликабельна и без права перестановки (только просмотр правок)", () => {
    const onMessageClick = vi.fn();
    const { container } = render(
      <SequenceDiagram
        participants={[P("a"), P("b")]}
        messages={[M("m0", 0)]}
        ghost
        onMessageClick={onMessageClick}
      />,
    );

    expect(grabStrips(container)).toHaveLength(1);
    fireEvent.click(grabStrips(container)[0]);
    expect(onMessageClick).toHaveBeenCalledWith("m0");
  });
});
