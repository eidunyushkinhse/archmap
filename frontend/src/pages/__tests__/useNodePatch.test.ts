// Поведенческие тесты useNodePatch (рендер-хук): CAS-коммиты, trim-guard,
// 409-ресинк, applyDocEvent, refresh.
import { renderHook, act, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useNodePatch } from "../useNodePatch";
import { nodesApi } from "../../api/nodes";
import { ApiError } from "../../api/client";
import type { Node, NodeDoc } from "../../types";

vi.mock("../../api/nodes", () => ({
  nodesApi: {
    update: vi.fn(),
    get: vi.fn(),
  },
}));

function makeNode(over: Partial<Node> = {}): Node {
  return {
    id: "n1",
    name: "Сервис",
    description: null,
    role: null,
    technology: null,
    parent_id: null,
    shape: "service",
    is_external: false,
    status: "existing",
    openapi_spec: null,
    version: 1,
    docs: [],
    has_children: false,
    child_count: 0,
    created_at: "",
    updated_at: "",
    ...over,
  } as Node;
}

function makeDoc(over: Partial<NodeDoc> = {}): NodeDoc {
  return {
    id: "d1",
    node_id: "n1",
    name: "Обзор",
    kind: "overview",
    operation: null,
    content: "graph TD",
    version: 1,
    ...over,
  } as NodeDoc;
}

describe("useNodePatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("инициализирует стейты из узла", () => {
    const { result } = renderHook(() => useNodePatch(makeNode({ name: "API", role: "ядро", is_external: true })));
    expect(result.current.name).toBe("API");
    expect(result.current.role).toBe("ядро");
    expect(result.current.isExternal).toBe(true);
    expect(result.current.node.id).toBe("n1");
  });

  it("commitName: пустое имя откатывается, без запроса", () => {
    const { result } = renderHook(() => useNodePatch(makeNode({ name: "Было" })));
    act(() => result.current.setName("   "));
    act(() => result.current.commitName());
    expect(result.current.name).toBe("Было");
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("commitName: неизменное имя — без запроса", () => {
    const { result } = renderHook(() => useNodePatch(makeNode({ name: "То же" })));
    act(() => result.current.commitName());
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("commitName: сохранение с CAS base_version", async () => {
    const saved = makeNode({ name: "Новое", version: 2 });
    vi.mocked(nodesApi.update).mockResolvedValue(saved);
    const onSaved = vi.fn();
    const { result } = renderHook(() => useNodePatch(makeNode({ name: "Старое", version: 3 }), onSaved));
    act(() => result.current.setName("Новое"));
    act(() => result.current.commitName());
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    const [id, payload] = vi.mocked(nodesApi.update).mock.calls[0];
    expect(id).toBe("n1");
    expect(payload.name).toBe("Новое");
    expect(payload.base_version).toBe(3);
    await waitFor(() => expect(result.current.node.version).toBe(2));
    expect(onSaved).toHaveBeenCalledWith(saved);
  });

  it("409 конфликт: рефреш + баннер, конфликт гасится при следующем успехе", async () => {
    const fresh = makeNode({ name: "Чужое", version: 9 });
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(409, "conflict"));
    vi.mocked(nodesApi.get).mockResolvedValue(fresh);
    const { result } = renderHook(() => useNodePatch(makeNode({ version: 1 })));
    act(() => result.current.setName("Моё"));
    act(() => result.current.commitName());
    await waitFor(() => expect(result.current.conflict).toBeTruthy());
    // Данные освежены из БД
    expect(result.current.name).toBe("Чужое");
    expect(result.current.node.version).toBe(9);
    // Следующий успешный коммит гасит баннер (меняем имя, иначе commitName — no-op)
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ name: "Моё2", version: 10 }));
    act(() => result.current.setName("Моё2"));
    act(() => result.current.commitName());
    await waitFor(() => expect(result.current.conflict).toBeNull());
  });

  it("applyDocEvent: create/edit/delete обновляют мету доков в стейте", () => {
    const d1 = makeDoc({ id: "d1", name: "Обзор", version: 1 });
    const { result } = renderHook(() => useNodePatch(makeNode({ docs: [{ id: "d1", name: "Обзор", kind: "overview", operation: null, version: 1, described: true }] })));

    // create
    const d2 = makeDoc({ id: "d2", name: "Операция", kind: "operation", version: 1 });
    act(() => result.current.applyDocEvent({ type: "create", nodeId: "n1", doc: d2 }));
    expect(result.current.node.docs).toHaveLength(2);
    expect(result.current.node.docs[1]).toMatchObject({ id: "d2", name: "Операция", kind: "operation" });

    // edit (правка контента → новая версия)
    const d1v2 = makeDoc({ id: "d1", name: "Обзор", version: 2 });
    act(() => result.current.applyDocEvent({ type: "edit", nodeId: "n1", before: d1, after: d1v2 }));
    expect(result.current.node.docs[0]).toMatchObject({ id: "d1", version: 2 });

    // delete
    act(() => result.current.applyDocEvent({ type: "delete", nodeId: "n1", doc: d2 }));
    expect(result.current.node.docs).toHaveLength(1);
    expect(result.current.node.docs[0].id).toBe("d1");
  });

  it("applyDocEvent пересчитывает признак «описана» по телу схемы", () => {
    // Мета собирается РУКАМИ (docToMeta), а сервер считает признак выражением в БД:
    // забыть его здесь значит уронить счётчик «описано N из M» после правки в оверлее.
    const заглушка = makeDoc({ id: "d1", name: "POST /orders", kind: "operation", content: "" });
    const { result } = renderHook(() => useNodePatch(makeNode({ docs: [] })));

    act(() => result.current.applyDocEvent({ type: "create", nodeId: "n1", doc: заглушка }));
    expect(result.current.node.docs[0].described).toBe(false);

    const описана = makeDoc({ ...заглушка, content: "flowchart TD\n A --> B", version: 2 });
    act(() => result.current.applyDocEvent({ type: "edit", nodeId: "n1", before: заглушка, after: описана }));
    expect(result.current.node.docs[0].described).toBe(true);

    // Тело из одних пробелов — та же заглушка, что и пустое (зеркало SQL-признака).
    const пробелы = makeDoc({ ...описана, content: "   \n ", version: 3 });
    act(() => result.current.applyDocEvent({ type: "edit", nodeId: "n1", before: описана, after: пробелы }));
    expect(result.current.node.docs[0].described).toBe(false);
  });

  it("refresh: применяет свежий узел целиком (стейты + CAS-база)", () => {
    const { result } = renderHook(() => useNodePatch(makeNode({ name: "Старое", role: null, version: 1 })));
    const fresh = makeNode({ name: "Свежее", role: "шлюз", version: 7 });
    act(() => result.current.refresh(fresh));
    expect(result.current.name).toBe("Свежее");
    expect(result.current.role).toBe("шлюз");
    expect(result.current.node.version).toBe(7);
  });

  it("pickShape: коммитит смену типа с CAS", async () => {
    // Кейс, ради которого поле стало редактируемым: импорт выдал серверу тип
    // «Пользователь», архитектор правит его со страницы.
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ shape: "service", version: 2 }));
    const { result } = renderHook(() => useNodePatch(makeNode({ shape: "person", version: 1 })));
    expect(result.current.shape).toBe("person");
    act(() => result.current.pickShape("service"));
    expect(result.current.shape).toBe("service");
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    const [, payload] = vi.mocked(nodesApi.update).mock.calls[0];
    expect(payload.shape).toBe("service");
    expect(payload.base_version).toBe(1);
    await waitFor(() => expect(result.current.node.shape).toBe("service"));
  });

  it("pickShape: тот же тип — без запроса", () => {
    const { result } = renderHook(() => useNodePatch(makeNode({ shape: "database" })));
    act(() => result.current.pickShape("database"));
    expect(nodesApi.update).not.toHaveBeenCalled();
  });

  it("отказ 400: причина видна, показанный тип откатывается, гаснет при следующем успехе", async () => {
    // «Молча не сработало» — худший исход: текст сервера обязан доехать до глаз.
    const причина = "У узла есть вложенные объекты — тип «Сервис» единственный, который может их иметь";
    vi.mocked(nodesApi.update).mockRejectedValue(new ApiError(400, причина));
    const { result } = renderHook(() => useNodePatch(makeNode({ shape: "service" })));
    act(() => result.current.pickShape("database"));
    await waitFor(() => expect(result.current.error).toBe(причина));
    // Показанный тип вернулся к сохранённому: интерфейс не показывает того, чего в БД нет
    expect(result.current.shape).toBe("service");
    // Это не конфликт версий — ни баннера, ни ресинка
    expect(result.current.conflict).toBeNull();
    expect(nodesApi.get).not.toHaveBeenCalled();
    // Следующая успешная правка гасит плашку
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ name: "Новое", version: 2 }));
    act(() => result.current.setName("Новое"));
    act(() => result.current.commitName());
    await waitFor(() => expect(result.current.error).toBeNull());
  });

  it("toggleExternal: инвертирует и коммитит", async () => {
    vi.mocked(nodesApi.update).mockResolvedValue(makeNode({ is_external: true, version: 2 }));
    const { result } = renderHook(() => useNodePatch(makeNode({ is_external: false })));
    act(() => result.current.toggleExternal());
    expect(result.current.isExternal).toBe(true);
    await waitFor(() => expect(nodesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(nodesApi.update).mock.calls[0][1].is_external).toBe(true);
  });
});
