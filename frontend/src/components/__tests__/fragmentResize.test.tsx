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
  ({ id: "f1", kind: "alt", fromRow, toRow, guard: "успех", branches: [] }) as unknown as SeqFragment;

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

// ── Ветви «иначе» (2026-08-10) ────────────────────────────────────────────────
// Ветвей у alt может быть сколько угодно: первая начинается с fromRow (её условие —
// guard фрагмента), остальные заданы своими строками.
const FB = (fromRow: number, toRow: number, rows: number[], kind = "alt"): SeqFragment =>
  ({
    id: "f1", kind, fromRow, toRow, guard: "успех",
    branches: rows.map((row, i) => ({ row, guard: ["отказ", "таймаут", "отмена"][i] ?? "иначе" })),
  }) as unknown as SeqFragment;

function renderWithBranches(over: {
  frag?: SeqFragment;
  messages?: SeqMessage[];
  onMoveBranch?: (id: string, index: number, row: number) => void;
  onEditBranch?: (id: string, index: number | null) => void;
} = {}) {
  return render(
    <SequenceDiagram
      participants={PARTICIPANTS}
      messages={over.messages ?? MESSAGES}
      fragments={[over.frag ?? FB(0, 2, [1])]}
      ghost
      onResizeFragment={vi.fn()}
      onMoveBranch={over.onMoveBranch}
      onEditBranch={over.onEditBranch}
    />,
  );
}

const elseButton = (c: HTMLElement) =>
  Array.from(c.querySelectorAll("button")).find((b) => b.textContent === "+ иначе");
const chip = (c: HTMLElement, text: string) =>
  Array.from(c.querySelectorAll("span")).find((x) => x.textContent === text);

describe("ветви «иначе» у alt", () => {
  it("«+ иначе» предлагается, пока ветвей нет", () => {
    const { container } = renderWithBranches({ frag: FB(0, 2, []), onEditBranch: vi.fn() });
    expect(elseButton(container)).toBeTruthy();
  });

  it("кнопка остаётся, пока под новую ветвь хватает шагов", () => {
    // Требование пользователя: не прятать «+ иначе», пока стрелок хватает.
    const { container } = renderWithBranches({ frag: FB(0, 2, [1]), onEditBranch: vi.fn() });
    expect(elseButton(container)).toBeTruthy();
  });

  it("когда свободных строк не осталось — кнопки нет", () => {
    // Охват из трёх шагов держит три ветви: первая + две строки.
    const { container } = renderWithBranches({ frag: FB(0, 2, [1, 2]), onEditBranch: vi.fn() });
    expect(elseButton(container)).toBeUndefined();
  });

  it("не-alt ветви не предлагает", () => {
    const { container } = renderWithBranches({ frag: FB(0, 2, [], "loop"), onEditBranch: vi.fn() });
    expect(elseButton(container)).toBeUndefined();
  });

  it("охват в один шаг делить нечем — кнопки нет", () => {
    const { container } = renderWithBranches({ frag: FB(1, 1, []), onEditBranch: vi.fn() });
    expect(elseButton(container)).toBeUndefined();
  });

  it("у каждой ветви своя ручка", () => {
    const { container } = renderWithBranches({ frag: FB(0, 2, [1, 2]), onMoveBranch: vi.fn() });
    expect(edges(container)).toHaveLength(4); // верх, низ и две ветви
  });

  it("каждая ветвь показывает своё условие", () => {
    const { container } = renderWithBranches({ frag: FB(0, 2, [1, 2]) });
    expect(chip(container, "отказ")).toBeTruthy();
    expect(chip(container, "таймаут")).toBeTruthy();
  });

  it("протягивание границы ветви отдаёт её номер и новую строку", () => {
    const onMoveBranch = vi.fn();
    const { container } = renderWithBranches({ onMoveBranch });

    fireEvent.pointerDown(edges(container)[2], { clientY: 300 });
    fireEvent.pointerMove(container.firstChild!, { clientY: 900 });
    fireEvent.pointerUp(container.firstChild!);

    expect(onMoveBranch).toHaveBeenCalledWith("f1", 0, 2);
  });

  it("ветвь не перепрыгивает соседнюю", () => {
    // Порядок ветвей строгий: вторая не может уехать выше первой.
    const onMoveBranch = vi.fn();
    const { container } = renderWithBranches({ frag: FB(0, 2, [1, 2]), onMoveBranch });

    fireEvent.pointerDown(edges(container)[3], { clientY: 900 }); // ручка ВТОРОЙ ветви
    fireEvent.pointerMove(container.firstChild!, { clientY: 0 }); // тянем в самый верх
    fireEvent.pointerUp(container.firstChild!);

    // Соседка стоит вплотную (строка 1), двигаться некуда — записывать нечего.
    expect(onMoveBranch).not.toHaveBeenCalled();
  });

  it("ветвь не поднимается на первую строку охвата", () => {
    // row == fromRow оставил бы ПЕРВУЮ ветвь пустой (бэк такое отклоняет).
    const onMoveBranch = vi.fn();
    const { container } = renderWithBranches({ onMoveBranch });

    fireEvent.pointerDown(edges(container)[2], { clientY: 300 });
    fireEvent.pointerMove(container.firstChild!, { clientY: 0 });
    fireEvent.pointerUp(container.firstChild!);

    // Единственная возможная строка — своя же (1), так что записывать нечего.
    expect(onMoveBranch).not.toHaveBeenCalled();
  });

  it("нижняя грань не проглатывает последнюю ветвь", () => {
    const onResize = vi.fn();
    const { container } = render(
      <SequenceDiagram
        participants={PARTICIPANTS}
        messages={MESSAGES}
        fragments={[FB(0, 2, [1, 2])]}
        ghost
        onResizeFragment={onResize}
        onMoveBranch={vi.fn()}
      />,
    );

    fireEvent.pointerDown(edges(container)[1], { clientY: 900 }); // низ рамки
    fireEvent.pointerMove(container.firstChild!, { clientY: 0 }); // тянем вверх
    fireEvent.pointerUp(container.firstChild!);

    // Нижняя ветвь стоит на последней строке охвата — грань упирается в неё и
    // остаётся на месте, менять нечего.
    expect(onResize).not.toHaveBeenCalled();
  });

  it("верхняя грань не проглатывает первую ветвь", () => {
    const onResize = vi.fn();
    const { container } = render(
      <SequenceDiagram
        participants={PARTICIPANTS}
        messages={MESSAGES}
        fragments={[FB(0, 2, [1, 2])]}
        ghost
        onResizeFragment={onResize}
        onMoveBranch={vi.fn()}
      />,
    );

    fireEvent.pointerDown(edges(container)[0], { clientY: 0 }); // верх рамки
    fireEvent.pointerMove(container.firstChild!, { clientY: 900 }); // тянем вниз
    fireEvent.pointerUp(container.firstChild!);

    // Первая ветвь на строке 1 — верхней грани дальше строки 0 хода нет.
    expect(onResize).not.toHaveBeenCalled();
  });

  it("клик по условию ветви открывает правку именно её", () => {
    const onEditBranch = vi.fn();
    const { container } = renderWithBranches({ frag: FB(0, 2, [1, 2]), onEditBranch });

    fireEvent.click(chip(container, "таймаут")!);

    expect(onEditBranch).toHaveBeenCalledWith("f1", 1);
  });

  it("каждая ветвь раздвигает строки на свой зазор", () => {
    // Молчаливый риск: без зазора на КАЖДУЮ ветвь разделители наезжают на стрелки —
    // ошибка не падает, а тихо смещает геометрию.
    const yOfLast = (c: HTMLElement) => {
      const ys = Array.from(c.querySelectorAll("line"))
        .map((l) => parseFloat(l.getAttribute("y1") ?? "0"))
        .filter((y) => y > 0);
      return Math.max(...ys);
    };
    const one = renderWithBranches({ frag: FB(0, 2, [1]) });
    const yOne = yOfLast(one.container);
    one.unmount();
    const two = renderWithBranches({ frag: FB(0, 2, [1, 2]) });

    expect(yOfLast(two.container)).toBeGreaterThan(yOne);
  });
});
