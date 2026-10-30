// Окно первого вложенного объекта при переносе (Р38 раздела 13 docs/plan-c4-elements.md):
// сервис без элемента переносят в лист-сервис без элемента — окно ДО переноса спрашивает
// со стороны переносимого, что он такое внутри цели, и ответ задаёт элемент цели.
// Хук и план исполняются по-настоящему; подменён только транспорт API.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Node } from "../../types";
import { configParamsApi, nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import { useFirstChild } from "../element/useFirstChild";
import type { MovedChild } from "../element/firstChild";

vi.mock("../../api/nodes", () => ({
  nodesApi: { get: vi.fn(), update: vi.fn() },
  configParamsApi: { list: vi.fn(() => Promise.resolve([])) },
}));

function leaf(over: Partial<Node> = {}): Node {
  return {
    id: "p1", name: "Order API", description: null, role: null, technology: null,
    parent_id: null, shape: "service", is_external: false, status: "existing",
    openapi_spec: null, version: 1, docs: [], has_children: false, child_count: 0,
    element: null, element_effective: "container", sites: [],
    created_at: "", updated_at: "",
    ...over,
  } as Node;
}

const onError = vi.fn();
let result: Promise<boolean> | null = null;

// Переносимый объект: сервис без элемента — тот, о ком спрашивает окно.
const CART: MovedChild = { name: "Корзина", shape: "service", element: null };

// Харнесс: кнопка зовёт ensure, окно хука рисуется рядом — как в редакторе.
function Harness({ parentId, child }: { parentId: string | null; child: MovedChild }) {
  const first = useFirstChild(onError);
  return (
    <>
      <button type="button" onClick={() => { result = first.ensure(parentId, child); }}>перенести</button>
      {first.dialog}
    </>
  );
}

async function run(parent: Node | null, child: MovedChild = CART) {
  if (parent) vi.mocked(nodesApi.get).mockResolvedValue(parent);
  render(<Harness parentId={parent ? parent.id : null} child={child} />);
  fireEvent.click(screen.getByText("перенести"));
}

const radios = () => [...document.querySelectorAll<HTMLInputElement>("dialog input[type=radio]")];
const checkedText = () => radios().find((r) => r.checked)?.closest("label")?.textContent ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  result = null;
  vi.mocked(nodesApi.update).mockResolvedValue(leaf());
});

describe("окно первого вложенного объекта при переносе", () => {
  it("лист со спецификацией — вопрос о переносимом, предвыбор «Компонент»; «Продолжить» делает лист контейнером", async () => {
    await run(leaf({ openapi_spec: "openapi: 3.0.0" }));
    expect(await screen.findByText("Что такое «Корзина» внутри «Order API»?")).toBeInTheDocument();
    expect(screen.getByText("От этого зависит, кем станет «Order API» и как ArchMap поведёт его документацию и площадки."))
      .toBeInTheDocument();
    expect(screen.getByText("Ответ можно изменить в свойствах «Order API».")).toBeInTheDocument();
    expect(radios().map((r) => r.closest("label")?.textContent)).toEqual([
      "КомпонентЧасть кода «Order API», отдельно не запускается. «Order API» станет контейнером, "
        + "документация и площадки останутся у него.",
      "Отдельное приложениеЗапускается само по себе. «Order API» станет системой, документация и "
        + "площадки ведутся у вложенных объектов.",
    ]);
    expect(checkedText()).toMatch(/^Компонент/);
    expect(nodesApi.update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Продолжить"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledWith("p1", { element: "container" }));
    await expect(result).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByText("Продолжить")).not.toBeInTheDocument());
  });

  it("предвыбор по площадкам листа — «Компонент»", async () => {
    await run(leaf({ sites: [{ id: "s1", name: "prod-eu", kind: "cloud", parent_id: null, parent_name: null, partial: false }] }));
    await screen.findByText("Продолжить");
    expect(checkedText()).toMatch(/^Компонент/);
    expect(configParamsApi.list).not.toHaveBeenCalled();
  });

  it("конфигурация решает предвыбор, когда спецификации и площадок нет", async () => {
    vi.mocked(configParamsApi.list).mockResolvedValueOnce([{ id: "c1" } as never]);
    await run(leaf());
    await screen.findByText("Продолжить");
    expect(checkedText()).toMatch(/^Компонент/);
  });

  it("без фактов — «Отдельное приложение»; выбранный вариант уходит в PATCH", async () => {
    await run(leaf());
    await screen.findByText("Продолжить");
    expect(checkedText()).toMatch(/^Отдельное приложение/);
    fireEvent.click(screen.getByText("Продолжить"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledWith("p1", { element: "system" }));
  });

  it("выбор «Компонент» делает лист контейнером", async () => {
    await run(leaf());
    await screen.findByText("Продолжить");
    fireEvent.click(radios()[0]); // «Компонент» — первый вариант
    fireEvent.click(screen.getByText("Продолжить"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledWith("p1", { element: "container" }));
  });

  it("«Отмена» ничего не пишет и не продолжает", async () => {
    await run(leaf());
    fireEvent.click(await screen.findByText("Отмена"));
    await expect(result).resolves.toBe(false);
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("база, брокер, «Пользователь» и сервис с элементом — цель система молча, без окна", async () => {
    const moved: MovedChild[] = [
      { name: "orders-db", shape: "database", element: null },
      { name: "events", shape: "broker", element: null },
      { name: "Покупатель", shape: "person", element: null },
      { name: "billing-worker", shape: "service", element: "container" },
      { name: "Склад", shape: "service", element: "system" },
    ];
    for (const child of moved) {
      vi.clearAllMocks();
      vi.mocked(nodesApi.update).mockResolvedValue(leaf());
      const { unmount } = render(<Harness parentId="p1" child={child} />);
      vi.mocked(nodesApi.get).mockResolvedValue(leaf({ openapi_spec: "openapi: 3.0.0" }));
      fireEvent.click(screen.getByText("перенести"));
      await expect(result).resolves.toBe(true);
      expect(nodesApi.update).toHaveBeenCalledWith("p1", { element: "system" });
      expect(screen.queryByText("Продолжить")).not.toBeInTheDocument();
      unmount();
    }
  });

  it.each([
    ["компонент (внутри контейнера выбора нет)", { element_effective: "component" as const }],
    ["у узла уже есть дети", { has_children: true, child_count: 1, element_effective: "system" as const }],
    ["элемент уже задан", { element: "container" as const }],
    ["пустая система (Р39)", { element: "system" as const, element_effective: "system" as const }],
    ["не сервис", { shape: "database" as const }],
  ])("%s — окна и записи нет", async (_label, over) => {
    await run(leaf(over));
    await expect(result).resolves.toBe(true);
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("корень — без запросов", async () => {
    await run(null);
    await expect(result).resolves.toBe(true);
    expect(nodesApi.get).not.toHaveBeenCalled();
  });

  it("сервис без элемента с вложенными объектами — тоже вопрос: план смотрит на хранимый элемент", async () => {
    await run(leaf(), { name: "Склад", shape: "service", element: null });
    expect(await screen.findByText("Что такое «Склад» внутри «Order API»?")).toBeInTheDocument();
  });

  it("отказ записи — onError, объект не переносится", async () => {
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(422, "Внутри лежит база данных «x»"));
    await run(leaf());
    fireEvent.click(await screen.findByText("Продолжить"));
    await act(async () => { await expect(result).resolves.toBe(false); });
    expect(onError).toHaveBeenCalledWith("Не удалось изменить «Order API»: Внутри лежит база данных «x»");
  });
});
