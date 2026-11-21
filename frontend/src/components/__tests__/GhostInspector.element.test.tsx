// Панель объекта с другого уровня (гость) в редакторе-карте (редизайн, фаза 4а): только
// просмотр. Строка «Тип» — тем же вычислением, что у своего объекта (Р40 раздела 13
// docs/plan-c4-elements.md), текстом; строки только со значением; одно действие —
// «Показать на схеме»; страница объекта — кнопкой заголовка, как у своего объекта.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import GhostInspector from "../inspector/GhostInspector";
import type { GhostNode } from "../../types";

const ghost = (over: Partial<GhostNode>): GhostNode => ({
  id: "g1", name: "api", role: null, technology: null, is_external: false,
  shape: "service", status: "existing", node_depth: 2, has_children: false,
  child_count: 0, element_effective: "container", ancestors: [], is_ghost: true, ...over,
});

const cb = () => ({ onShowOnMap: vi.fn(), onNavigateNode: vi.fn(), onClose: vi.fn() });
const typeValue = () => screen.getByText("Тип").nextElementSibling;
const terms = () => [...document.querySelectorAll(".np-term")].map((t) => t.textContent);

describe("GhostInspector: строка «Тип»", () => {
  it("система, контейнер, база данных и «Пользователь» — текстом", () => {
    const cases = [
      [ghost({ has_children: true, child_count: 2, element_effective: "system" }), "Система"],
      [ghost({}), "Контейнер"],
      [ghost({ shape: "database" }), "База данных"],
      [ghost({ shape: "person", element_effective: null }), "Пользователь"],
    ] as const;
    for (const [g, text] of cases) {
      const { unmount } = render(<GhostInspector ghost={g} {...cb()} />);
      expect(typeValue()).toHaveTextContent(text);
      expect(screen.queryByText("Элемент архитектуры")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Тип" })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("компонент — «Компонент», контейнер виден в «Расположении»", () => {
    render(
      <GhostInspector
        ghost={ghost({
          element_effective: "component",
          ancestors: [
            { id: "s", name: "Торговля", is_external: false, element_effective: "system" },
            { id: "c", name: "orders", is_external: false, element_effective: "container" },
          ],
        })}
        {...cb()}
      />,
    );
    expect(typeValue()?.textContent).toBe("Компонент");
    expect(screen.getByText("Расположение").nextElementSibling).toHaveTextContent("Торговля / orders");
    expect(screen.queryByRole("button", { name: "«orders»" })).toBeNull();
  });
});

describe("GhostInspector: панель", () => {
  it("заголовок: название, «Открыть страницу объекта» и «Закрыть»", async () => {
    const c = cb();
    render(<GhostInspector ghost={ghost({ name: "Банк" })} {...c} />);
    expect(screen.getByRole("heading", { name: "Банк" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Открыть страницу объекта" }));
    expect(c.onNavigateNode).toHaveBeenCalledWith("g1");
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(c.onClose).toHaveBeenCalledOnce();
  });

  it("строки только со значением; подписи «с другого уровня» и пояснения нет", () => {
    const { unmount } = render(<GhostInspector ghost={ghost({})} {...cb()} />);
    expect(terms()).toEqual(["Тип", "Статус"]);
    expect(screen.queryByText(/с другого уровня/)).toBeNull();
    expect(screen.queryByText(/можно только посмотреть/)).toBeNull();
    expect(document.querySelectorAll("input, textarea")).toHaveLength(0);
    unmount();
    render(<GhostInspector ghost={ghost({
      role: "шлюз", technology: "Kong", status: "planned",
      ancestors: [{ id: "s", name: "Торговля", is_external: false, element_effective: "system" }],
    })} {...cb()} />);
    expect(terms()).toEqual(["Тип", "Роль", "Технология", "Расположение", "Статус"]);
    expect(screen.getByText("Статус").nextElementSibling).toHaveTextContent("Проектируется");
  });

  it("одно действие — «Показать на схеме»", async () => {
    const c = cb();
    const g = ghost({});
    render(<GhostInspector ghost={g} {...c} />);
    expect(screen.queryByRole("button", { name: "Перейти к оригиналу" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Показать на схеме" }));
    expect(c.onShowOnMap).toHaveBeenCalledWith(g);
    expect(c.onNavigateNode).not.toHaveBeenCalled();
  });
});
