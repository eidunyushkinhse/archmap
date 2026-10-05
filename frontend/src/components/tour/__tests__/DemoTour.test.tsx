// Корень тура: автозапуск при первом входе гостя, хранение по id гостя, «Пропустить»
// навсегда, «Обучение» — заново (короткий проход, если свой проект уже есть), переход на
// экран шага, сигналы маршрута и шины событий продукта.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Me } from "../../../types";

const YAR = "aaaa-0001";
const OWN = "bbbb-0002";
const GUEST: Me = {
  id: "g-1", username: "guest-1", role: "architect", is_admin: false, is_guest: true, can_create_project: true,
};
const auth = vi.hoisted(() => ({ me: null as Me | null, canCreate: true }));

vi.mock("../../../api/auth", () => ({
  getMe: () => auth.me,
  subscribeMe: () => () => {},
  fetchMe: () => Promise.resolve(auth.me),
  getCanCreateProject: () => auth.canCreate,
}));
vi.mock("../../../api/projects", () => ({
  projectsApi: { list: vi.fn(async () => [{ id: YAR, name: "Маркетплейс «Ярмарка»" }]) },
}));
vi.mock("../../../api/nodes", () => ({
  nodesApi: {
    getAll: vi.fn(async () => [
      { id: "c0de-01", name: "Продавец" }, { id: "c0de-03", name: "Сервис заказов" },
      { id: "c0de-07", name: "Оркестратор заказа" },
    ]),
  },
}));

import DemoTour from "../DemoTour";
import { emitTourEvent } from "../tourBus";
import { getTourPaused, requestTourRestart, requestTourResume, tourKey } from "../tourStore";

const KEY = tourKey(GUEST.id);
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as { status: string; step: string } | null;

// Элемент-цель с ненулевым прямоугольником: jsdom геометрии не считает.
function target(attr: string, rect = { x: 100, y: 100, w: 200, h: 120 }): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-tour", attr);
  place(el, rect);
  document.body.appendChild(el);
  return el;
}

/** Поставить элемент-цель в прямоугольник окна (прокрутка, зум и пан двигают его так). */
function place(el: HTMLElement, rect: { x: number; y: number; w: number; h: number }) {
  el.getBoundingClientRect = () => ({
    x: rect.x, y: rect.y, left: rect.x, top: rect.y, width: rect.w, height: rect.h,
    right: rect.x + rect.w, bottom: rect.y + rect.h, toJSON: () => ({}),
  });
}

function goHash(hash: string) {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

beforeEach(() => {
  localStorage.clear();
  auth.me = GUEST;
  auth.canCreate = true;
  window.location.hash = "/projects";
});
afterEach(() => {
  document.querySelectorAll("[data-tour]").forEach((el) => el.remove());
});
// Копии гаснущих карточек и затемнения прошлых тестов (их размонтировал cleanup) ещё в DOM.
beforeEach(() => {
  document.querySelectorAll(".tour-card--ghost, .tour-art--ghost").forEach((el) => el.parentElement?.remove());
});

describe("DemoTour", () => {
  it("первый вход гостя — приветствие само; прежние гости этого браузера забыты", async () => {
    localStorage.setItem(tourKey("old-guest"), JSON.stringify({ status: "running" }));
    render(<DemoTour />);
    expect(await screen.findByRole("dialog", { name: "Добро пожаловать в ArchMap" })).toBeInTheDocument();
    expect(stored()).toMatchObject({ status: "running", step: "welcome" });
    expect(localStorage.getItem(tourKey("old-guest"))).toBeNull();
  });

  it("не гость — тура нет", () => {
    auth.me = { ...GUEST, is_guest: false };
    render(<DemoTour />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("«Пропустить» — сохранено, и сам тур больше не появится", async () => {
    const first = render(<DemoTour />);
    fireEvent.click(await screen.findByRole("button", { name: "Пропустить" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(stored()).toMatchObject({ status: "done" });
    first.unmount();
    render(<DemoTour />);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("«Начать» ведёт к карточке «Ярмарки»; открыл проект — следующий шаг", async () => {
    window.location.hash = `/p/${OWN}`;
    target(`project:${YAR}`);
    render(<DemoTour />);
    fireEvent.click(await screen.findByRole("button", { name: "Начать" }));
    await waitFor(() => expect(window.location.hash).toBe("#/projects"));
    expect(await screen.findByRole("dialog", { name: "Откройте «Ярмарку»" })).toBeInTheDocument();
    expect(screen.getByText("Шаг 1 из 27")).toBeInTheDocument();
    target("schema-block");
    act(() => goHash(`/p/${YAR}`));
    expect(await screen.findByRole("dialog", { name: "Главная страница проекта" })).toBeInTheDocument();
  });

  it("«Обучение» при уже созданном проекте — короткий проход по «Ярмарке»", async () => {
    localStorage.setItem(KEY, JSON.stringify({ status: "done", step: "final", variant: "full", dir: 1, vars: {} }));
    target(`project:${YAR}`);
    render(<DemoTour />);
    expect(screen.queryByRole("dialog")).toBeNull();
    auth.canCreate = false;
    act(() => requestTourRestart());
    fireEvent.click(await screen.findByRole("button", { name: "Начать" }));
    expect(await screen.findByText("Шаг 1 из 14")).toBeInTheDocument();
  });

  it("событие шины продвигает шаг: система создана — дальше второй объект", async () => {
    window.location.hash = `/p/${OWN}/map`;
    localStorage.setItem(KEY, JSON.stringify({
      status: "running", step: "create-system", variant: "full", dir: 1, vars: { ownProjectId: OWN },
    }));
    target("palette:service");
    target("palette", { x: 10, y: 600, w: 300, h: 180 });
    render(<DemoTour />);
    expect(await screen.findByRole("dialog", { name: "Создайте свою систему" })).toBeInTheDocument();
    act(() => emitTourEvent({ type: "node-created", id: "s1", name: "Касса", shape: "service", parentId: null }));
    expect(await screen.findByRole("dialog", { name: "Добавьте ещё один объект" })).toBeInTheDocument();
    expect(stored()).toMatchObject({ step: "add-peer", vars: { systemId: "s1", systemName: "Касса" } });
  });

  it("повторный проход: узел уже раскрыт с прошлого раза — шаг засчитан сразу", async () => {
    window.location.hash = `/p/${YAR}/map`;
    localStorage.setItem(KEY, JSON.stringify({ status: "running", step: "expand-service", variant: "full", dir: 1, vars: {} }));
    const frame = target("frame-probe");
    frame.removeAttribute("data-tour");
    frame.className = "react-flow__node react-flow__node-frame";
    frame.setAttribute("data-id", "c0de-03");
    render(<DemoTour />);
    await waitFor(() => expect(stored()).toMatchObject({ step: "service-expanded" }));
    frame.remove();
  });

  it("«Назад» на шаг с лупой при раскрытом узле — шаг ждёт", async () => {
    window.location.hash = `/p/${YAR}/map`;
    localStorage.setItem(KEY, JSON.stringify({ status: "running", step: "expand-service", variant: "full", dir: -1, vars: {} }));
    const frame = target("frame-probe");
    frame.removeAttribute("data-tour");
    frame.className = "react-flow__node react-flow__node-frame";
    frame.setAttribute("data-id", "c0de-03");
    render(<DemoTour />);
    expect(await screen.findByRole("dialog", { name: "Внутри системы её сервисы" })).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(stored()).toMatchObject({ step: "expand-service" });
    frame.remove();
  });

  it("дерево: ветка «Сервиса заказов» раскрыта — шаг засчитан; дальше строка «Оркестратора»", async () => {
    window.location.hash = `/p/${YAR}/nodes/c0de-03`;
    localStorage.setItem(KEY, JSON.stringify({ status: "running", step: "tree", variant: "full", dir: 1, vars: {} }));
    const chev = target("tree-chev:c0de-03", { x: 10, y: 300, w: 26, h: 28 });
    chev.setAttribute("aria-expanded", "false");
    render(<DemoTour />);
    expect(await screen.findByRole("dialog", { name: "Дерево системы" })).toBeInTheDocument();
    expect(screen.getByText("Шаг 8 из 27")).toBeInTheDocument();
    chev.setAttribute("aria-expanded", "true");
    await waitFor(() => expect(stored()).toMatchObject({ step: "tree-open" }));
    target("tree-row:c0de-07", { x: 10, y: 330, w: 240, h: 28 });
    expect(await screen.findByRole("dialog", { name: "Откройте страницу объекта" })).toBeInTheDocument();
    act(() => goHash(`/p/${YAR}/nodes/c0de-07`));
    await waitFor(() => expect(stored()).toMatchObject({ step: "service-docs" }));
  });

  it("«Назад» на шаг дерева при раскрытой ветке — ждёт, пока её свернут и раскроют снова", async () => {
    window.location.hash = `/p/${YAR}/nodes/c0de-03`;
    localStorage.setItem(KEY, JSON.stringify({ status: "running", step: "tree", variant: "full", dir: -1, vars: {} }));
    const chev = target("tree-chev:c0de-03", { x: 10, y: 300, w: 26, h: 28 });
    chev.setAttribute("aria-expanded", "true");
    render(<DemoTour />);
    expect(await screen.findByRole("dialog", { name: "Дерево системы" })).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
    expect(stored()).toMatchObject({ step: "tree" });
    chev.setAttribute("aria-expanded", "false");
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    chev.setAttribute("aria-expanded", "true");
    await waitFor(() => expect(stored()).toMatchObject({ step: "tree-open" }));
  });

  it("шаг перевеса связи: плашки подписей пропускают нажатия к ручке конца", async () => {
    window.location.hash = `/p/${OWN}/map`;
    localStorage.setItem(KEY, JSON.stringify({
      status: "running", step: "rehang", variant: "full", dir: 1,
      vars: { ownProjectId: OWN, systemId: "s1", systemName: "Касса", peerId: "p1", peerName: "Банк" },
    }));
    const view = render(<DemoTour />);
    await waitFor(() => expect(document.body).toHaveClass("tour-pass-labels"));
    act(() => emitTourEvent({ type: "edge-reconnected", fromId: "s1", toId: "c1" }));
    await waitFor(() => expect(document.body).not.toHaveClass("tour-pass-labels"));
    view.unmount();
  });

  it("цели нет на экране — после паузы карточка сбоку без затемнения", async () => {
    window.location.hash = `/p/${OWN}`;
    localStorage.setItem(KEY, JSON.stringify({
      status: "running", step: "create-system", variant: "full", dir: 1, vars: { ownProjectId: OWN },
    }));
    render(<DemoTour />);
    const card = await screen.findByRole("dialog", { name: "Создайте свою систему" }, { timeout: 3000 });
    expect(card).toHaveClass("tour-card--docked");
    expect(document.querySelector("[data-tour-blocker]")).toBeNull();
  });
});

// Плавные переходы (tourMotion.ts): время — поддельное, вместе с requestAnimationFrame и
// performance.now(), поэтому кадры кадрового цикла идут ровно по часам теста.
describe("DemoTour — плавные переходы", () => {
  const ringLeft = () => parseFloat(document.querySelector<HTMLElement>("[data-tour-layer] .tour-ring")?.style.left ?? "NaN");
  const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout",
        "setInterval", "clearInterval", "Date"],
    });
    window.location.hash = `/p/${YAR}`;
    localStorage.setItem(KEY, JSON.stringify({ status: "running", step: "yar-home", variant: "full", dir: 1, vars: {} }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("та же цель сдвинулась — вырез за ней в том же кадре; смена цели — вырез перетекает, без пустого кадра", async () => {
    const block = target("schema-block", { x: 100, y: 100, w: 200, h: 120 });
    target("schema-edit", { x: 600, y: 400, w: 80, h: 30 });
    render(<DemoTour />);
    await tick(1000);
    expect(screen.getByRole("dialog", { name: "Главная страница проекта" })).toBeInTheDocument();
    expect(ringLeft()).toBe(94);
    // прокрутка сдвинула ту же цель — без твина, рамка уже на новом месте
    place(block, { x: 140, y: 100, w: 200, h: 120 });
    await tick(20);
    expect(ringLeft()).toBe(134);
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    // до кадра нового шага на экране прежний кадр целиком — слой не пропадает
    expect(document.querySelector("[data-tour-layer]")).not.toBeNull();
    expect(document.querySelector("[data-tour-layer] .tour-ring")).not.toBeNull();
    await tick(150);
    expect(screen.getByRole("dialog", { name: "Откройте редактор" })).toBeInTheDocument();
    // вырез в пути: уже не на прежней цели и ещё не на новой
    expect(ringLeft()).toBeGreaterThan(134);
    expect(ringLeft()).toBeLessThan(594);
    expect(document.querySelector("[data-tour-layer] .tour-ring")).not.toHaveClass("tour-ring--act"); // пульс ждёт конца
    await tick(600);
    expect(ringLeft()).toBe(594);
    expect(document.querySelector("[data-tour-layer] .tour-ring")).toHaveClass("tour-ring--act");
  });

  it("зона пары пропала на кадр-другой (холст монтируется) — вырезы и рамки не дрогнули", async () => {
    window.location.hash = `/p/${OWN}/map`;
    localStorage.setItem(KEY, JSON.stringify({
      status: "running", step: "create-system", variant: "full", dir: 1, vars: { ownProjectId: OWN },
    }));
    target("palette:service", { x: 10, y: 600, w: 150, h: 40 });
    const flow = document.createElement("div");
    flow.className = "react-flow";
    place(flow, { x: 400, y: 80, w: 900, h: 700 });
    document.body.appendChild(flow);
    try {
      render(<DemoTour />);
      await tick(1000);
      const rings = () => [...document.querySelectorAll<HTMLElement>("[data-tour-layer] .tour-ring")]
        .map((r) => `${r.style.left},${r.style.top},${r.style.width},${r.style.height}`);
      const settled = rings();
      expect(settled).toHaveLength(2);
      flow.remove();
      await tick(50);
      expect(rings()).toEqual(settled);
      document.body.appendChild(flow);
      await tick(400);
      expect(rings()).toEqual(settled);
      // зона ушла по-настоящему — после удержания её вырез стягивается и исчезает
      flow.remove();
      await tick(700);
      expect(rings()).toHaveLength(1);
    } finally {
      flow.remove();
    }
  });

  it("открылось окно, а шаг ещё прежний — затемнение не проседает; цель так и не в окне — тур прячется", async () => {
    window.location.hash = "/projects";
    localStorage.setItem(KEY, JSON.stringify({ status: "running", step: "new-project", variant: "full", dir: 1, vars: {} }));
    target("new-project", { x: 800, y: 140, w: 180, h: 40 });
    const shade = () => document.querySelector("[data-tour-layer] .tour-shade rect[mask]")?.getAttribute("opacity") ?? null;
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    try {
      render(<DemoTour />);
      await tick(1000);
      expect(shade()).toBe("1");
      document.body.appendChild(dialog);
      await tick(80);
      expect(shade()).toBe("1");
      await tick(500);
      expect(shade()).toBeNull();
    } finally {
      dialog.remove();
    }
  });

  it("«Обучение» после выхода из тура — прежний кадр не мелькает до первого кадра нового прохода", async () => {
    target("schema-block", { x: 100, y: 100, w: 200, h: 120 });
    render(<DemoTour />);
    await tick(1000);
    fireEvent.click(screen.getByRole("button", { name: "Пропустить обучение" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { requestTourRestart(); await Promise.resolve(); await Promise.resolve(); });
    // проход начался, кадрового цикла ещё не было: на экране ни карточки прежнего шага,
    // ни его затемнения
    expect(stored()).toMatchObject({ status: "running", step: "welcome" });
    expect(screen.queryByRole("dialog", { name: "Главная страница проекта" })).toBeNull();
    expect(document.querySelector("[data-tour-layer] .tour-ring")).toBeNull();
    await tick(100);
    expect(screen.getByRole("dialog", { name: "Добро пожаловать в ArchMap" })).toBeInTheDocument();
  });

  it("без анимаций (prefers-reduced-motion) — вырез на новой цели в ближайшем кадре", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    target("schema-block", { x: 100, y: 100, w: 200, h: 120 });
    target("schema-edit", { x: 600, y: 400, w: 80, h: 30 });
    render(<DemoTour />);
    await tick(100);
    expect(ringLeft()).toBe(94);
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await tick(20);
    expect(ringLeft()).toBe(594);
  });
});

// Пауза (docs/tasks/demo-tour-pause.md): клик по затемнению сворачивает тур в пилюлю
// «Продолжить обучение»; продолжение — с того же места. Время поддельное, как выше.
describe("DemoTour — пауза", () => {
  const tick = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
  // нажатие на затемнение вдали от выреза
  const pokeShade = () => fireEvent.pointerDown(document.querySelector("[data-tour-blocker]")!, { clientX: 900, clientY: 600, button: 0 });
  const layer = () => document.querySelector("[data-tour-layer]");
  // браузер после смены хэша шлёт hashchange — в jsdom шлём сами
  const hashSettled = () => act(() => { window.dispatchEvent(new HashChangeEvent("hashchange")); });

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout",
        "setInterval", "clearInterval", "Date"],
    });
    window.location.hash = `/p/${YAR}`;
    localStorage.setItem(KEY, JSON.stringify({ status: "running", step: "yar-home", variant: "full", dir: 1, vars: {} }));
    target("schema-block", { x: 100, y: 100, w: 200, h: 120 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("клик по затемнению — тур на паузе, страница свободна; «Продолжить обучение» — тот же шаг", async () => {
    render(<DemoTour />);
    await tick(1000);
    pokeShade();
    expect(layer()).toBeNull();
    expect(stored()).toMatchObject({ status: "paused", step: "yar-home" });
    expect(getTourPaused()).toBe(true);
    await tick(2000);
    expect(layer()).toBeNull();
    act(() => requestTourResume());
    await tick(1000);
    expect(screen.getByRole("dialog", { name: "Главная страница проекта" })).not.toHaveClass("tour-card--docked");
    expect(stored()).toMatchObject({ status: "running", step: "yar-home" });
    expect(getTourPaused()).toBe(false);
  });

  it("клик по затемнению — карточка шага сворачивается в пилюлю «Продолжить обучение»", async () => {
    const box = (x: number, y: number, w: number, h: number) => ({
      x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}),
    }) as DOMRect;
    const pill = document.createElement("button");
    pill.setAttribute("data-tour-pill", "");
    document.body.appendChild(pill);
    const animate = vi.fn(() => ({ finished: new Promise(() => {}) }) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true, writable: true });
    const rects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.matches("[data-tour-pill]")) return box(900, 10, 160, 28);
      return this.classList.contains("tour-card") ? box(320, 100, 340, 200) : box(0, 0, 0, 0);
    });
    try {
      render(<DemoTour />);
      await tick(1000);
      pokeShade();
      await tick(20);
      expect(document.querySelector(".tour-card--fly")).not.toBeNull();
      expect(animate).toHaveBeenCalled();
    } finally {
      rects.mockRestore();
      delete (HTMLElement.prototype as Partial<HTMLElement>).animate;
      pill.remove();
      document.querySelectorAll(".tour-card--fly").forEach((el) => el.parentElement?.remove());
    }
  });

  it("на паузе тур никуда не уводит; «Продолжить обучение» возвращает на экран паузы", async () => {
    render(<DemoTour />);
    await tick(1000);
    pokeShade();
    act(() => goHash("/projects"));
    await tick(2000);
    expect(window.location.hash).toBe("#/projects");
    expect(layer()).toBeNull();
    act(() => requestTourResume());
    expect(window.location.hash).toBe(`#/p/${YAR}`);
    hashSettled();
    await tick(1000);
    expect(screen.getByRole("dialog", { name: "Главная страница проекта" })).not.toHaveClass("tour-card--docked");
  });

  it("действие шага, сделанное на паузе, засчитано: «Продолжить обучение» — следующий шаг", async () => {
    localStorage.setItem(KEY, JSON.stringify({ status: "running", step: "open-editor", variant: "full", dir: 1, vars: {} }));
    target("schema-edit", { x: 600, y: 400, w: 80, h: 30 });
    render(<DemoTour />);
    await tick(1000);
    expect(screen.getByRole("dialog", { name: "Откройте редактор" })).toBeInTheDocument();
    pokeShade();
    act(() => goHash(`/p/${YAR}/map`));
    await tick(500);
    expect(stored()).toMatchObject({ status: "paused", step: "drag" });
    expect(layer()).toBeNull();
    act(() => requestTourResume());
    expect(window.location.hash).toBe(`#/p/${YAR}/map`); // экран нового шага — уже тот
    await tick(2000);
    expect(stored()).toMatchObject({ status: "running", step: "drag" });
    expect(screen.getByRole("dialog", { name: "Объекты можно двигать" })).toBeInTheDocument();
  });

  it("финал: клик по затемнению завершает тур", async () => {
    localStorage.setItem(KEY, JSON.stringify({ status: "running", step: "final", variant: "full", dir: 1, vars: {} }));
    render(<DemoTour />);
    await tick(500);
    expect(screen.getByRole("dialog", { name: "Теперь вы знаете, с чего начать" })).toBeInTheDocument();
    pokeShade();
    expect(stored()).toMatchObject({ status: "done" });
    expect(layer()).toBeNull();
    expect(getTourPaused()).toBe(false);
  });

  it("пауза переживает перезагрузку: тур сам не появляется, ждёт пилюли", async () => {
    localStorage.setItem(KEY, JSON.stringify({
      status: "paused", step: "yar-home", variant: "full", dir: 1, vars: {}, pause: { step: "yar-home", hash: `#/p/${YAR}` },
    }));
    render(<DemoTour />);
    await tick(1000);
    expect(layer()).toBeNull();
    expect(getTourPaused()).toBe(true);
    act(() => requestTourResume());
    // «Ярмарку» тур ищет, только когда идёт: первый такт — её поиск, второй — кадры
    await tick(100);
    await tick(1000);
    expect(screen.getByRole("dialog", { name: "Главная страница проекта" })).not.toHaveClass("tour-card--docked");
  });
});
