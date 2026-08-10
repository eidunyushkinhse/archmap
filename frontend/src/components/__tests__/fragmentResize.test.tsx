// Правка охвата фрагмента протягиванием грани.
//
// Ключевое требование: во время жеста ширина рамки подстраивается под самую
// широкую стрелку внутри НОВОГО охвата. Ширина выводится из крайних колонок
// покрытых сообщений, поэтому тест меряет её до и во время протягивания.
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import SequenceDiagram from "../processes/SequenceDiagram";
import type { SeqFragment, SeqMessage, SeqParticipant } from "../processes/sequence/layout";

const P = (id: string): SeqParticipant =>
  ({ id, name: id.toUpperCase(), shape: "service", external: false, status: "existing", role: null }) as SeqParticipant;

const M = (id: string, r: number, from: string, to: string): SeqMessage =>
  ({ id, r, from, to, kind: "call", valid: true, caption: id }) as unknown as SeqMessage;

const F = (fromRow: number, toRow: number): SeqFragment =>
  ({ id: "f1", kind: "alt", fromRow, toRow, guard: "успех", elseRow: null, elseGuard: null }) as unknown as SeqFragment;

// Три участника: строка 0 — короткая стрелка a→b, строка 1 — длинная a→c.
const PARTICIPANTS = [P("a"), P("b"), P("c")];
const MESSAGES = [M("m0", 0, "a", "b"), M("m1", 1, "a", "c"), M("m2", 2, "a", "b")];

function renderDiagram(onResizeFragment?: (id: string, from: number, to: number) => void) {
  return render(
    <SequenceDiagram
      participants={PARTICIPANTS}
      messages={MESSAGES}
      fragments={[F(0, 0)]} // накрывает только короткую стрелку
      ghost
      onResizeFragment={onResizeFragment}
    />,
  );
}

// Рамка фрагмента — единственный div с янтарной рамкой и скруглением 8px.
const frameOf = (c: HTMLElement): HTMLElement => {
  const el = Array.from(c.querySelectorAll("div")).find(
    (d) => d.style.borderRadius === "8px" && d.style.border.includes("1.5px"),
  );
  if (!el) throw new Error("рамка фрагмента не найдена");
  return el as HTMLElement;
};
// Ручки граней: полосы с курсором ns-resize (верхняя, затем нижняя).
const edges = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("div")).filter((d) => d.style.cursor === "ns-resize");

const widthOf = (el: HTMLElement) => parseFloat(el.style.width);

describe("охват фрагмента: протягивание грани", () => {
  it("у рамки есть ручки обеих граней", () => {
    const { container } = renderDiagram(vi.fn());
    expect(edges(container)).toHaveLength(2);
  });

  it("без обработчика ручек нет", () => {
    const { container } = renderDiagram(undefined);
    expect(edges(container)).toHaveLength(0);
  });

  it("во время протягивания ширина растёт под самую широкую стрелку охвата", () => {
    const { container } = renderDiagram(vi.fn());
    const widthBefore = widthOf(frameOf(container));

    // Тянем нижнюю грань вниз — в охват попадает длинная стрелка a→c.
    fireEvent.pointerDown(edges(container)[1], { clientY: 100 });
    fireEvent.pointerMove(container.firstChild!, { clientY: 900 });

    const widthDuring = widthOf(frameOf(container));
    expect(widthDuring).toBeGreaterThan(widthBefore);
  });

  it("ширина анимируется, а не прыгает", () => {
    // Требование пользователя: подстройка должна читаться как движение.
    const { container } = renderDiagram(vi.fn());
    expect(frameOf(container).style.transition).toContain("width");
  });

  it("отпускание отдаёт новый охват", () => {
    const onResize = vi.fn();
    const { container } = renderDiagram(onResize);

    fireEvent.pointerDown(edges(container)[1], { clientY: 100 });
    fireEvent.pointerMove(container.firstChild!, { clientY: 900 });
    fireEvent.pointerUp(container.firstChild!);

    expect(onResize).toHaveBeenCalledTimes(1);
    const [id, from, to] = onResize.mock.calls[0];
    expect(id).toBe("f1");
    expect(from).toBe(0); // верхняя грань не двигалась
    expect(to).toBeGreaterThan(0); // нижняя уехала вниз
  });

  it("сдвиг в пределах порога охват не меняет", () => {
    const onResize = vi.fn();
    const { container } = renderDiagram(onResize);

    fireEvent.pointerDown(edges(container)[1], { clientY: 100 });
    fireEvent.pointerMove(container.firstChild!, { clientY: 102 });
    fireEvent.pointerUp(container.firstChild!);

    expect(onResize).not.toHaveBeenCalled();
  });

  it("нижняя грань не уходит выше верхней", () => {
    // Схлопывание диапазона запрещено и на бэке (from_order ≤ to_order) — не даём
    // отправить заведомо отклоняемое.
    const onResize = vi.fn();
    const { container } = render(
      <SequenceDiagram
        participants={PARTICIPANTS}
        messages={MESSAGES}
        fragments={[F(1, 2)]}
        ghost
        onResizeFragment={onResize}
      />,
    );

    fireEvent.pointerDown(edges(container)[1], { clientY: 900 }); // нижняя грань
    fireEvent.pointerMove(container.firstChild!, { clientY: 0 }); // тянем в самый верх
    fireEvent.pointerUp(container.firstChild!);

    if (onResize.mock.calls.length) {
      const [, from, to] = onResize.mock.calls[0];
      expect(to).toBeGreaterThanOrEqual(from);
    }
  });
});
