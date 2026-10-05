// Слой тура: карточка по виду шага (приветствие, «Далее», ожидание действия,
// финал), затемнение с вырезами, пропуск жеста из выреза сквозь затемнение,
// карточка «в стороне» без затемнения, рисование в открытый <dialog>.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import TourLayer from "../TourLayer";
import { STEPS, type StepId } from "../tourSteps";
import type { TourView } from "../tourView";

function view(patch: Partial<TourView>): TourView {
  return { phase: "spot", host: document.body, holes: [], anchor: null, avoid: [], soft: [], ...patch };
}

function renderLayer(stepId: StepId, v: TourView, canBack = true) {
  const handlers = { onNext: vi.fn(), onBack: vi.fn(), onSkip: vi.fn(), onFinish: vi.fn(), onShade: vi.fn() };
  const step = STEPS[stepId];
  const utils = render(
    <TourLayer
      view={v}
      stepKey={stepId}
      step={step}
      texts={{ title: step.title, body: step.body, action: step.action }}
      count={step.n ? `Шаг ${step.n} из 27` : null}
      canBack={canBack}
      {...handlers}
    />,
  );
  return { ...utils, handlers };
}

const HOLE = { x: 100, y: 100, w: 200, h: 80, shape: "rect" as const };

// Копии гаснущих карточек и затемнения прошлых тестов (их размонтировал cleanup) ещё в DOM.
beforeEach(() => {
  document.querySelectorAll(".tour-card--ghost, .tour-art--ghost").forEach((el) => el.parentElement?.remove());
});

describe("TourLayer", () => {
  it("приветствие: по центру, «Пропустить» и «Начать», затемнение без вырезов", () => {
    const { handlers } = renderLayer("welcome", view({ phase: "center" }), false);
    expect(screen.getByRole("dialog", { name: "Добро пожаловать в ArchMap" })).toHaveClass("tour-card--center");
    expect(screen.queryByText(/Шаг/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Начать" }));
    fireEvent.click(screen.getByRole("button", { name: "Пропустить" }));
    expect(handlers.onNext).toHaveBeenCalledOnce();
    expect(handlers.onSkip).toHaveBeenCalledOnce();
    expect(document.querySelector("[data-tour-blocker]")).not.toBeNull();
    expect(document.querySelector("[data-tour-layer] .tour-ring")).toBeNull();
  });

  it("шаг с действием: счётчик, строка действия, пульс, без «Далее»", () => {
    const { handlers } = renderLayer("open-editor", view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE] }));
    expect(screen.getByText("Шаг 3 из 27")).toBeInTheDocument();
    expect(screen.getByText("Нажмите «Редактировать».")).toHaveClass("tour-do");
    expect(screen.queryByRole("button", { name: "Далее" })).toBeNull();
    expect(document.querySelector("[data-tour-layer] .tour-ring")).toHaveClass("tour-ring--act");
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: "Пропустить обучение" }));
    expect(handlers.onBack).toHaveBeenCalledOnce();
    expect(handlers.onSkip).toHaveBeenCalledOnce();
  });

  it("шаг с «Далее»: без пульса, карточка рядом с целью", () => {
    const { handlers } = renderLayer("yar-home", view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE] }));
    expect(document.querySelector("[data-tour-layer] .tour-ring")).not.toHaveClass("tour-ring--act");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect(handlers.onNext).toHaveBeenCalledOnce();
    const card = screen.getByRole("dialog", { name: "Главная страница проекта" });
    expect(card.style.left).toBe(`${HOLE.x + HOLE.w + 16}px`);
  });

  it("зона второго выреза не пульсирует; шаг без текста — только заголовок и действие", () => {
    const zone = { x: 400, y: 100, w: 500, h: 400, shape: "rect" as const, quiet: true };
    renderLayer("enter-system", view({ holes: [HOLE, zone], anchor: HOLE, avoid: [HOLE], soft: [zone] }));
    const rings = document.querySelectorAll("[data-tour-layer] .tour-ring");
    expect(rings).toHaveLength(2);
    expect(rings[0]).toHaveClass("tour-ring--act");
    expect(rings[1]).not.toHaveClass("tour-ring--act");
    const card = screen.getByRole("dialog", { name: "Перейдём на следующий слой архитектуры" });
    // тело пустое — абзаца нет, есть только строка действия
    expect(card.querySelectorAll("p")).toHaveLength(1);
    expect(card.querySelector("p")).toHaveClass("tour-do");
  });

  it("финал: только «Завершить»", () => {
    const { handlers } = renderLayer("final", view({ phase: "center" }));
    expect(screen.queryByRole("button", { name: /Пропустить/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Назад" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Завершить" }));
    expect(handlers.onFinish).toHaveBeenCalledOnce();
  });

  it("жест, начатый в вырезе, проходит сквозь затемнение до отпускания", () => {
    vi.useFakeTimers();
    try {
      renderLayer("create-system", view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE] }));
      const blocker = document.querySelector("[data-tour-blocker]")!;
      expect(blocker).not.toHaveClass("tour-blocker--pass");
      // нажатие мимо выреза — затемнение держит
      fireEvent.pointerDown(document.body, { clientX: 10, clientY: 10 });
      expect(blocker).not.toHaveClass("tour-blocker--pass");
      fireEvent.pointerDown(document.body, { clientX: 150, clientY: 120 });
      expect(blocker).toHaveClass("tour-blocker--pass");
      // нативный драг из палитры: отпускание мыши его не обрывает
      fireEvent.dragStart(document.body);
      fireEvent.pointerUp(document.body);
      act(() => { vi.runAllTimers(); });
      expect(blocker).toHaveClass("tour-blocker--pass");
      fireEvent.drop(document.body);
      act(() => { vi.runAllTimers(); });
      expect(blocker).not.toHaveClass("tour-blocker--pass");
    } finally {
      vi.useRealTimers();
    }
  });

  it("клик по затемнению — пауза; промах рядом с вырезом, правая кнопка и карточка — нет", () => {
    const { handlers } = renderLayer("drag", view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE] }));
    const blocker = document.querySelector("[data-tour-blocker]")!;
    // до 24 px от края выреза — промах мимо цели
    fireEvent.pointerDown(blocker, { clientX: HOLE.x - 20, clientY: HOLE.y + 10, button: 0 });
    fireEvent.pointerDown(blocker, { clientX: 600, clientY: 500, button: 2 });
    fireEvent.pointerDown(screen.getByRole("dialog"), { clientX: 600, clientY: 500, button: 0 });
    expect(handlers.onShade).not.toHaveBeenCalled();
    fireEvent.pointerDown(blocker, { clientX: 600, clientY: 500, button: 0 });
    expect(handlers.onShade).toHaveBeenCalledOnce();
  });

  it("приветствие: клик по затемнению вокруг карточки — тоже onShade", () => {
    const { handlers } = renderLayer("welcome", view({ phase: "center" }), false);
    fireEvent.pointerDown(document.querySelector("[data-tour-blocker]")!, { clientX: 20, clientY: 20, button: 0 });
    expect(handlers.onShade).toHaveBeenCalledOnce();
  });

  it("пользователь не на экране шага: карточка сбоку, без затемнения", () => {
    renderLayer("drag", view({ phase: "docked" }));
    expect(screen.getByRole("dialog", { name: "Объекты можно двигать" })).toHaveClass("tour-card--docked");
    expect(document.querySelector("[data-tour-blocker]")).toBeNull();
  });

  it("цель ещё грузится или открыто чужое окно — ничего не рисуем", () => {
    renderLayer("drag", view({ phase: "pending" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    renderLayer("drag", view({ phase: "hidden", host: null }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("цель внутри открытого <dialog> — слой рисуется в него", () => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    try {
      renderLayer("create-blank", view({ host: dialog, holes: [HOLE], anchor: HOLE, avoid: [HOLE] }));
      expect(dialog.querySelector(".tour-card")).not.toBeNull();
    } finally {
      dialog.remove();
    }
  });

  // Окно убрали по успеху (проект создан) — слой не уходит из документа вместе с ним до
  // кадра тура: переходит в body в той же отрисовке. Таймеры и rAF стоят — значит,
  // перенос без кадрового цикла.
  it.each([
    ["убрали из DOM", (d: HTMLDialogElement) => d.remove()],
    ["закрыли", (d: HTMLDialogElement) => d.removeAttribute("open")],
  ])("окно-хозяин %s — слой сразу в body, затемнение не мигает", async (_name, kill) => {
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout"] });
    try {
      renderLayer("create-blank", view({ host: dialog, holes: [HOLE], anchor: HOLE, avoid: [HOLE] }));
      expect(document.querySelector("[data-tour-layer]")?.parentElement).toBe(dialog);
      await act(async () => { kill(dialog); await Promise.resolve(); });
      const layer = document.querySelector("[data-tour-layer]");
      expect(layer?.parentElement).toBe(document.body);
      expect(layer?.querySelector(".tour-shade rect[mask]")).not.toBeNull();
      // карточка уже была на экране — перенесённая, заново не проявляется
      expect(layer?.querySelector(".tour-card")).toHaveClass("tour-card--moved");
    } finally {
      vi.useRealTimers();
      dialog.remove();
    }
  });

  it("тур закрыт — затемнение гаснет копией; погасшее до нуля копии не оставляет", async () => {
    vi.useFakeTimers();
    try {
      const v = view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE] });
      const step = STEPS["open-editor"];
      const props = {
        view: v, stepKey: "open-editor", step, texts: { title: step.title, body: step.body, action: step.action },
        count: null, canBack: true, onNext: vi.fn(), onBack: vi.fn(), onSkip: vi.fn(), onFinish: vi.fn(), onShade: vi.fn(),
      };
      const shown = render(<TourLayer {...props} motion={{ opacity: 1, holes: [{ ...HOLE, r: 10, alpha: 1 }], settled: true }} />);
      shown.unmount();
      await act(async () => { await Promise.resolve(); });
      const ghost = document.querySelector(".tour-art--ghost");
      expect(ghost).not.toBeNull();
      expect(ghost).toHaveAttribute("aria-hidden", "true");
      expect(ghost?.querySelector(".tour-ring")).not.toBeNull();
      act(() => { vi.advanceTimersByTime(500); });
      expect(document.querySelector(".tour-art--ghost")).toBeNull();
      const faded = render(<TourLayer {...props} motion={{ opacity: 0.02, holes: [], settled: true }} />);
      faded.unmount();
      await act(async () => { await Promise.resolve(); });
      expect(document.querySelector(".tour-art--ghost")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("смена шага: копия прежней карточки гаснет на старом месте, новая проявляется", async () => {
    vi.useFakeTimers();
    try {
      const v = view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE] });
      const props = (id: StepId) => {
        const step = STEPS[id];
        return {
          view: v, stepKey: id, step, texts: { title: step.title, body: step.body, action: step.action },
          count: null, canBack: true, onNext: vi.fn(), onBack: vi.fn(), onSkip: vi.fn(), onFinish: vi.fn(), onShade: vi.fn(),
        };
      };
      const { rerender } = render(<TourLayer {...props("yar-home")} />);
      rerender(<TourLayer {...props("open-editor")} />);
      await act(async () => { await Promise.resolve(); });
      const ghost = document.querySelector(".tour-card--ghost");
      expect(ghost).not.toBeNull();
      expect(ghost).toHaveAttribute("aria-hidden", "true");
      expect(ghost?.textContent).toContain("Главная страница проекта");
      // для чтения с экрана и для нажатий карточка одна — новая
      expect(screen.getAllByRole("dialog")).toHaveLength(1);
      expect(screen.getByRole("dialog", { name: "Откройте редактор" })).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(500); });
      expect(document.querySelector(".tour-card--ghost")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

