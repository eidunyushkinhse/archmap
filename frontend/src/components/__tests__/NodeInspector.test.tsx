// Правая панель редактора: смена ТИПА узла (форма C4) архитектором, отказ сервера
// плашкой и полное отсутствие редактора у наблюдателя. Смена типа коммитится сразу
// (как статус) и уходит в Undo редактора тем же onNodeSaved, что и остальная мета —
// своей истории у панели нет.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import NodeInspector from "../inspector/NodeInspector";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { Node } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: {
    update: vi.fn(),
    get: vi.fn(),
    getDescendants: vi.fn(() => Promise.resolve([])),
    deletionSnapshot: vi.fn(),
    delete: vi.fn(),
    // Живая нормализация якоря: форма поля «Якорь» зовёт её при вводе.
    anchorPreview: vi.fn(),
  },
}));

function makeNode(over: Partial<Node> = {}): Node {
  return {
    id: "n1",
    name: "Monitored Hosts",
    description: null,
    role: null,
    technology: null,
    parent_id: null,
    shape: "person",
    is_external: false,
    status: "existing",
    openapi_spec: null,
    version: 3,
    docs: [],
    has_children: false,
    child_count: 0,
    created_at: "",
    updated_at: "",
    ...over,
  } as Node;
}

const cb = {
  onNodeSaved: vi.fn(),
  onNodeDeleted: vi.fn(),
  onNavigateNode: vi.fn(),
};

function setup(node: Node, isArchitect = true) {
  return render(<NodeInspector node={node} isArchitect={isArchitect} {...cb} />);
}

describe("NodeInspector: смена типа", () => {
  beforeEach(() => vi.clearAllMocks());

  it("архитектор меняет тип из выпадашки — PATCH с новой формой и запись в историю", async () => {
    const saved = makeNode({ shape: "service", version: 4 });
    vi.mocked(nodesApi.update).mockResolvedValue(saved);
    const before = makeNode({ shape: "person" });
    setup(before);

    await userEvent.click(screen.getByRole("button", { name: /Пользователь/ }));
    await userEvent.click(screen.getByRole("option", { name: "Сервис" }));

    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    const [id, payload] = vi.mocked(nodesApi.update).mock.calls[0];
    expect(id).toBe("n1");
    expect(payload.shape).toBe("service");
    // CAS от версии последнего сохранённого — как у любой правки панели
    expect(payload.base_version).toBe(3);
    // Undo редактора достаётся бесплатно: полный payload + узел ДО правки
    await waitFor(() => expect(cb.onNodeSaved).toHaveBeenCalledWith(saved, false, before));
  });

  it("тот же тип — без запроса", async () => {
    setup(makeNode({ shape: "service" }));
    await userEvent.click(screen.getByRole("button", { name: /Сервис/ }));
    await userEvent.click(screen.getByRole("option", { name: "Сервис" }));
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("отказ сервера показан плашкой, а не проглочен", async () => {
    const причина = "У узла описана структура БД — сначала перенесите или удалите её";
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(400, причина));
    setup(makeNode({ shape: "database" }));

    await userEvent.click(screen.getByRole("button", { name: /База данных/ }));
    await userEvent.click(screen.getByRole("option", { name: "Сервис" }));

    expect(await screen.findByText(причина)).toBeInTheDocument();
    // Правка не применилась — в историю ничего не легло
    expect(cb.onNodeSaved).not.toHaveBeenCalled();
  });

  it("наблюдателю тип показан текстом, редактора нет", async () => {
    setup(makeNode({ shape: "person" }), false);
    await waitFor(() => expect(screen.getAllByText("Пользователь").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: /Пользователь/ })).toBeNull();
  });
});


// ── Якорь ───────────────────────────────────────────────────────────────────
// Та же строка «Якорь», что и в карточке объекта (один компонент на оба места):
// в редакторе она правится не выходя с карты и уходит тем же save с CAS.
describe("NodeInspector: якорь", () => {
  beforeEach(() => vi.clearAllMocks());

  it("показывает якорь узла и правит его тем же PATCH с base_version", async () => {
    const n = makeNode({ shape: "service", source: { repo: null, path: null, host: "kafka" }, version: 3 });
    vi.mocked(nodesApi.anchorPreview).mockResolvedValue({
      source: { repo: "github.com/org/repo", path: null, host: null }, kind: "code", key: "git:github.com/org/repo",
    });
    vi.mocked(nodesApi.update).mockResolvedValue(
      makeNode({ source: { repo: "github.com/org/repo", path: null, host: null }, version: 4 }),
    );
    render(<NodeInspector node={n} isArchitect {...cb} />);

    expect(screen.getByText("имя зависимости:")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Изменить" }));
    await userEvent.click(screen.getByRole("radio", { name: "Код" }));
    await userEvent.type(screen.getByLabelText("Репозиторий"), "github.com/org/repo");
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));

    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1]).toMatchObject({
      source: { repo: "github.com/org/repo", path: null },
      base_version: 3,
    });
    expect(cb.onNodeSaved).toHaveBeenCalled();
  });

  it("наблюдателю якорь только читается", () => {
    const n = makeNode({ shape: "service", source: { repo: "github.com/org/repo", path: null, host: null } });
    render(<NodeInspector node={n} isArchitect={false} {...cb} />);
    expect(screen.getByText("код:")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Изменить" })).toBeNull();
  });
});

// Тогл «Размещение» инвертирован по решению пользователя 2026-09-04: «включён»
// (синий) — ВНУТРЕННИЙ сервис, «выключен» (серый) — внешний. Данные при этом
// прежние: клик по-прежнему переключает is_external.
describe("NodeInspector: тогл размещения", () => {
  beforeEach(() => vi.clearAllMocks());

  it("внутренний — тогл включён и подписан «Внутренний», внешний — выключен", () => {
    const { unmount } = setup(makeNode({ is_external: false }));
    const inner = screen.getByRole("button", { name: "Внутренний" });
    expect(inner.getAttribute("aria-pressed")).toBe("true");
    expect(inner.querySelector(".insp-switch")?.classList.contains("is-on")).toBe(true);
    unmount();

    setup(makeNode({ is_external: true }));
    const outer = screen.getByRole("button", { name: "Внешний" });
    expect(outer.getAttribute("aria-pressed")).toBe("false");
    expect(outer.querySelector(".insp-switch")?.classList.contains("is-on")).toBe(false);
  });

  it("клик по тоглу переключает is_external, а не вид", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ is_external: true, version: 4 }));
    setup(makeNode({ is_external: false }));
    await userEvent.click(screen.getByRole("button", { name: "Внутренний" }));
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1].is_external).toBe(true);
  });
});
