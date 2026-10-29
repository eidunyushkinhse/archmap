// Окно первого вложенного объекта (Р4 эпика «Элемент архитектуры»): лист-сервис без
// элемента, получая первого ребёнка, спрашивает «что это такое» — ДО создания или
// переноса. Хук и план исполняются по-настоящему; подменён только транспорт API.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Node, NodeShape } from "../../types";
import { configParamsApi, nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import { useFirstChild } from "../element/useFirstChild";
import { setTourRunning } from "../tour/tourBus";

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

// Харнесс: кнопка зовёт ensure, окно хука рисуется рядом — как на страницах.
function Harness({ parentId, shape }: { parentId: string | null; shape: NodeShape }) {
  const first = useFirstChild(onError);
  return (
    <>
      <button type="button" onClick={() => { result = first.ensure(parentId, shape); }}>создать</button>
      {first.dialog}
    </>
  );
}

async function run(parent: Node | null, shape: NodeShape = "service") {
  if (parent) vi.mocked(nodesApi.get).mockResolvedValue(parent);
  render(<Harness parentId={parent ? parent.id : null} shape={shape} />);
  fireEvent.click(screen.getByText("создать"));
}

const radios = () => [...document.querySelectorAll<HTMLInputElement>("dialog input[type=radio]")];
const checkedText = () => radios().find((r) => r.checked)?.closest("label")?.textContent ?? "";

beforeEach(() => {
  vi.clearAllMocks();
  result = null;
  vi.mocked(nodesApi.update).mockResolvedValue(leaf());
});
afterEach(() => setTourRunning(false));

describe("окно первого вложенного объекта", () => {
  it("лист со спецификацией — окно с предвыбором «Контейнер»; «Продолжить» пишет элемент", async () => {
    await run(leaf({ openapi_spec: "openapi: 3.0.0" }));
    expect(await screen.findByText("Внутри «Order API» появился первый объект")).toBeInTheDocument();
    expect(screen.getByText(/Уточните, что такое «Order API»/)).toBeInTheDocument();
    expect(screen.getByText("Ответ можно изменить в любой момент в свойствах «Order API».")).toBeInTheDocument();
    expect(checkedText()).toMatch(/^Контейнер/);
    expect(nodesApi.update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Продолжить"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledWith("p1", { element: "container" }));
    await expect(result).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByText("Продолжить")).not.toBeInTheDocument());
  });

  it("предвыбор по площадкам и по конфигурации; без фактов — «Система», выбор меняется", async () => {
    await run(leaf({ sites: [{ id: "s1", name: "prod-eu", kind: "cloud", parent_id: null, parent_name: null, partial: false }] }));
    await screen.findByText("Продолжить");
    expect(checkedText()).toMatch(/^Контейнер/);
    expect(configParamsApi.list).not.toHaveBeenCalled();
  });

  it("конфигурация решает предвыбор, когда спецификации и площадок нет", async () => {
    vi.mocked(configParamsApi.list).mockResolvedValueOnce([{ id: "c1" } as never]);
    await run(leaf());
    await screen.findByText("Продолжить");
    expect(checkedText()).toMatch(/^Контейнер/);
  });

  it("без фактов — «Система»; выбранный вариант уходит в PATCH", async () => {
    await run(leaf());
    await screen.findByText("Продолжить");
    expect(checkedText()).toMatch(/^Система/);
    fireEvent.click(radios()[0]); // «Контейнер» — первый вариант
    fireEvent.click(screen.getByText("Продолжить"));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledWith("p1", { element: "container" }));
  });

  it("«Отмена» ничего не пишет и не продолжает", async () => {
    await run(leaf());
    fireEvent.click(await screen.findByText("Отмена"));
    await expect(result).resolves.toBe(false);
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("база, брокер и «Пользователь» — система молча, без окна", async () => {
    for (const shape of ["database", "broker", "person"] as const) {
      vi.clearAllMocks();
      vi.mocked(nodesApi.update).mockResolvedValue(leaf());
      const { unmount } = render(<Harness parentId="p1" shape={shape} />);
      vi.mocked(nodesApi.get).mockResolvedValue(leaf({ openapi_spec: "openapi: 3.0.0" }));
      fireEvent.click(screen.getByText("создать"));
      await expect(result).resolves.toBe(true);
      expect(nodesApi.update).toHaveBeenCalledWith("p1", { element: "system" });
      expect(screen.queryByText("Продолжить")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("тур идёт — система явно, без окна", async () => {
    setTourRunning(true);
    await run(leaf({ openapi_spec: "openapi: 3.0.0" }));
    await expect(result).resolves.toBe(true);
    expect(nodesApi.update).toHaveBeenCalledWith("p1", { element: "system" });
    expect(screen.queryByText("Продолжить")).not.toBeInTheDocument();
  });

  it.each([
    ["компонент (внутри контейнера выбора нет)", { element_effective: "component" as const }],
    ["у узла уже есть дети", { has_children: true, child_count: 1, element_effective: "system" as const }],
    ["элемент уже задан", { element: "container" as const }],
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

  it("отказ записи — onError, ребёнок не создаётся", async () => {
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(422, "Внутри лежит база данных «x»"));
    await run(leaf());
    fireEvent.click(await screen.findByText("Продолжить"));
    await act(async () => { await expect(result).resolves.toBe(false); });
    expect(onError).toHaveBeenCalledWith("Не удалось изменить «Order API»: Внутри лежит база данных «x»");
  });
});
