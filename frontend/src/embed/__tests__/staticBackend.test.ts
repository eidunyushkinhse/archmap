// Статический бэкенд живой схемы лендинга: отвечает на запросы холста из снимка сцены,
// остальное — 404; чужие запросы уходят настоящему fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Node } from "../../types";
import type { LandingScene } from "../scene";
import { installStaticBackend, staticReply } from "../staticBackend";

function makeNode(over: Partial<Node> = {}): Node {
  return {
    id: "c1",
    name: "Order API",
    description: null,
    role: null,
    technology: null,
    parent_id: "p1",
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

const scene: LandingScene = {
  source: { project: "Ярмарка", focus: "Сервис заказов" },
  graph: {
    nodes: [], edges: [], endpoints: [], layout: {},
    version: 3, graph_rev: 7, meta_rev: 0, has_status_info: false,
  },
  containerId: "sys",
  layoutViewId: "p1",
  ancestors: [{ id: "sys", name: "Маркетплейс «Ярмарка»", is_external: false }],
  children: { p1: [makeNode()] },
};

const url = (path: string) => new URL(`http://localhost/api/v1${path}`);

describe("staticReply", () => {
  it("отдаёт состав контейнера из снимка, у незнакомого — пустой", () => {
    const state = { version: 3 };
    expect(staticReply(scene, state, "GET", url("/nodes?parent_id=p1"))).toEqual({
      status: 200, body: [makeNode()],
    });
    expect(staticReply(scene, state, "GET", url("/nodes?parent_id=zz"))).toEqual({ status: 200, body: [] });
  });

  it("запись раскладки поднимает версию вида и несёт graph_rev снимка", () => {
    const state = { version: 3 };
    expect(staticReply(scene, state, "PUT", url("/views/p1/layout"))).toEqual({
      status: 200, body: { version: 4, graph_rev: 7 },
    });
    expect(staticReply(scene, state, "PUT", url("/views/root/layout")).body).toEqual({ version: 5, graph_rev: 7 });
  });

  it("на прочие запросы — 404 с методом и путём в detail", () => {
    const reply = staticReply(scene, { version: 3 }, "GET", url("/nodes/p1/graph"));
    expect(reply.status).toBe(404);
    expect(reply.body).toEqual({ detail: "Живая схема лендинга не отвечает на GET /nodes/p1/graph" });
  });
});

describe("installStaticBackend", () => {
  const original = window.fetch;
  afterEach(() => {
    window.fetch = original;
    vi.restoreAllMocks();
  });

  it("перехватывает /api/v1 своего источника, остальное отдаёт настоящему fetch", async () => {
    const real = vi.fn(() => Promise.resolve(new Response("ok")));
    window.fetch = real;
    installStaticBackend(scene);

    const res = await window.fetch("/api/v1/nodes?parent_id=p1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([makeNode()]);

    const put = await window.fetch("/api/v1/views/p1/layout", { method: "PUT", body: "{}" });
    expect(await put.json()).toEqual({ version: 4, graph_rev: 7 });

    await window.fetch("https://fonts.example/font.woff2");
    await window.fetch("/assets/elk.js");
    expect(real).toHaveBeenCalledTimes(2);
  });

  it("незнакомый запрос к API — 404 и предупреждение в консоль", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installStaticBackend(scene);
    const res = await window.fetch("/api/v1/nodes/alerts");
    expect(res.status).toBe(404);
    expect(warn).toHaveBeenCalledOnce();
  });
});
