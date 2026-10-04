// Корень тура: автозапуск при первом входе гостя, хранение по id гостя, «Пропустить»
// навсегда, «?» — заново (короткий проход, если свой проект уже есть), переход на
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
  nodesApi: { getAll: vi.fn(async () => [{ id: "c0de-01", name: "Продавец" }]) },
}));

import DemoTour from "../DemoTour";
import { emitTourEvent } from "../tourBus";
import { requestTourRestart, tourKey } from "../tourStore";

const KEY = tourKey(GUEST.id);
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null") as { status: string; step: string } | null;

// Элемент-цель с ненулевым прямоугольником: jsdom геометрии не считает.
function target(attr: string, rect = { x: 100, y: 100, w: 200, h: 120 }): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-tour", attr);
  el.getBoundingClientRect = () => ({
    x: rect.x, y: rect.y, left: rect.x, top: rect.y, width: rect.w, height: rect.h,
    right: rect.x + rect.w, bottom: rect.y + rect.h, toJSON: () => ({}),
  });
  document.body.appendChild(el);
  return el;
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
    expect(screen.getByText("Шаг 1 из 24")).toBeInTheDocument();
    target("schema-block");
    act(() => goHash(`/p/${YAR}`));
    expect(await screen.findByRole("dialog", { name: "Главная страница проекта" })).toBeInTheDocument();
  });

  it("«?» при уже созданном проекте — короткий проход по «Ярмарке»", async () => {
    localStorage.setItem(KEY, JSON.stringify({ status: "done", step: "final", variant: "full", dir: 1, vars: {} }));
    target(`project:${YAR}`);
    render(<DemoTour />);
    expect(screen.queryByRole("dialog")).toBeNull();
    auth.canCreate = false;
    act(() => requestTourRestart());
    fireEvent.click(await screen.findByRole("button", { name: "Начать" }));
    expect(await screen.findByText("Шаг 1 из 13")).toBeInTheDocument();
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
