// Слой тура: карточка по виду шага (приветствие, «Далее», ожидание действия,
// финал), затемнение с вырезами, пропуск жеста из выреза сквозь затемнение,
// карточка «в стороне» без затемнения, рисование в открытый <dialog>.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import TourLayer from "../TourLayer";
import { markExitToPill } from "../tourStore";
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
      count={step.n ? `Шаг ${step.n} из 25` : null}
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
    expect(screen.getByText("Шаг 3 из 25")).toBeInTheDocument();
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

  // Пауза (docs/tasks/demo-tour-pause.md): карточка шага сворачивается в пилюлю
  // «Продолжить обучение». В jsdom нет раскладки и Web Animations — рамки и animate
  // подменены: проверяем, куда и как полетела копия.
  describe("сворачивание в пилюлю", () => {
    const rect = (x: number, y: number, w: number, h: number) => ({
      x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}),
    }) as DOMRect;
    const CARD = rect(500, 300, 340, 200), PILL = rect(1200, 10, 160, 28);
    let pill: HTMLButtonElement;
    const animate = vi.fn((..._args: unknown[]) => ({ finished: Promise.resolve() }) as unknown as Animation);
    const props = () => {
      const step = STEPS["yar-home"];
      return {
        view: view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE] }), stepKey: "yar-home", step,
        texts: { title: step.title, body: step.body, action: step.action }, count: null, canBack: true,
        onNext: vi.fn(), onBack: vi.fn(), onSkip: vi.fn(), onFinish: vi.fn(), onShade: vi.fn(),
      };
    };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout", "clearTimeout"] });
      animate.mockClear();
      Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true, writable: true });
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.matches("[data-tour-pill]")) return PILL;
        return this.classList.contains("tour-card") ? CARD : rect(0, 0, 0, 0);
      });
      pill = document.createElement("button");
      pill.setAttribute("data-tour-pill", "");
      document.body.appendChild(pill);
    });
    afterEach(() => {
      pill.remove();
      vi.restoreAllMocks();
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
      vi.useRealTimers();
    });

    it("ушла по клику на затемнение — копия летит в рамку пилюли, текст гаснет по пути", async () => {
      const shown = render(<TourLayer {...props()} />);
      markExitToPill();
      shown.unmount();
      await act(async () => { await Promise.resolve(); });
      const ghost = document.querySelector<HTMLElement>(".tour-card--fly");
      expect(ghost).not.toBeNull();
      expect(ghost).toHaveAttribute("aria-hidden", "true");
      expect(ghost?.style.left).toBe("500px");
      act(() => { vi.advanceTimersByTime(20); }); // кадр спустя — перелёт
      const flight = animate.mock.calls.find(([frames]) => (frames as Keyframe[]).length === 3);
      const frames = flight?.[0] as Keyframe[];
      // центр карточки (670, 400) → центр пилюли (1280, 24); 340×200 → 160×28
      expect(frames[2].transform).toBe(`translate(610px, -376px) scale(${160 / 340}, ${28 / 200})`);
      expect(frames[2].opacity).toBe(0);
      expect(frames[1].offset).toBeGreaterThan(0.5);
      // текст карточки гаснет отдельно, раньше конца перелёта
      expect(animate.mock.calls.filter(([f]) => (f as Keyframe[]).length === 2).length).toBeGreaterThan(0);
      await act(async () => { await Promise.resolve(); });
      expect(document.querySelector(".tour-card--fly")).toBeNull();
    });

    it("пилюли на экране нет — обычное угасание; без клика по затемнению — тоже", async () => {
      pill.remove();
      const first = render(<TourLayer {...props()} />);
      markExitToPill();
      first.unmount();
      await act(async () => { await Promise.resolve(); });
      expect(document.querySelector(".tour-card--fly")).toBeNull();
      expect(document.querySelector(".tour-card--ghost")).not.toBeNull();
      document.querySelectorAll(".tour-card--ghost").forEach((el) => el.parentElement?.remove());
      document.body.appendChild(pill);
      const second = render(<TourLayer {...props()} />);
      second.unmount();
      await act(async () => { await Promise.resolve(); });
      expect(document.querySelector(".tour-card--fly")).toBeNull();
    });
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


describe("TourLayer — демонстрация перевеса", () => {
  const DEMO = {
    grab: { x: 300, y: 142 }, drop: { x: 420, y: 142 }, dropSide: "left" as const,
    fixed: { x: 161, y: 142 }, fixedSide: "right" as const, headAtFixed: false, zoom: 1,
  };

  it("ладонь и копия стрелки поверх затемнения, мышь слой не ловит", () => {
    renderLayer("rehang", view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE], demo: DEMO }));
    const layer = document.querySelector("[data-tour-layer] [data-tour-demo]");
    expect(layer).toHaveClass("tour-demo");
    expect(layer?.querySelector("[data-demo='hand']")).not.toBeNull();
    // связь входит в рамку: тянут её конец, наконечник — у ладони, как у превью-линии холста
    const ghost = layer?.querySelector("[data-demo='ghost-path']");
    expect(ghost?.getAttribute("marker-end")).toMatch(/^url\(#/);
    expect(ghost?.getAttribute("marker-start")).toBeNull();
  });

  it("рамка — начало связи: наконечник у неподвижного конца", () => {
    renderLayer("rehang", view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE], demo: { ...DEMO, headAtFixed: true } }));
    const ghost = document.querySelector("[data-tour-demo] [data-demo='ghost-path']");
    expect(ghost?.getAttribute("marker-start")).toMatch(/^url\(#/);
    expect(ghost?.getAttribute("marker-end")).toBeNull();
  });

  it("нет демонстрации у шага или вырезы ещё едут — слоя нет", () => {
    renderLayer("connect", view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE] }));
    expect(document.querySelector("[data-tour-demo]")).toBeNull();
    const step = STEPS.rehang;
    render(
      <TourLayer
        view={view({ holes: [HOLE], anchor: HOLE, avoid: [HOLE], demo: DEMO })}
        motion={{ opacity: 1, holes: [], settled: false }}
        stepKey="rehang" step={step} texts={{ title: step.title, body: step.body, action: step.action }}
        count={null} canBack onNext={vi.fn()} onBack={vi.fn()} onSkip={vi.fn()} onFinish={vi.fn()} onShade={vi.fn()}
      />,
    );
    expect(document.querySelector("[data-tour-demo]")).toBeNull();
  });
});
