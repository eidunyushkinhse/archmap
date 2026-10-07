// Статический бэкенд живой схемы лендинга. Сам холст ходит в API ровно за двумя
// вещами: составом раскрытой рамки (GET /nodes?parent_id=) и записью раскладки
// (PUT /views/{id}/layout). Здесь на них отвечают снимок сцены и память вкладки,
// поэтому схема работает на статическом хостинге, без сервера и без записи в БД.
// Остальные запросы получают 404 с понятным detail и предупреждение в консоль: новая
// зависимость холста от API так видна сразу, а не тихо ломает раскрытие.
import type { LandingScene } from "./scene";

const API = "/api/v1";

export interface StaticReply {
  status: number;
  body: unknown;
}

// Счётчик версии вида: ответ на запись раскладки несёт новую версию, как настоящий.
export interface StaticState {
  version: number;
}

export function staticReply(scene: LandingScene, state: StaticState, method: string, url: URL): StaticReply {
  const path = url.pathname.slice(API.length);
  if (method === "GET" && path === "/nodes") {
    const parentId = url.searchParams.get("parent_id");
    return { status: 200, body: parentId ? (scene.children[parentId] ?? []) : [] };
  }
  if (method === "PUT" && /^\/views\/[^/]+\/layout$/.test(path)) {
    // Позиции и раскрытия хранит зеркало холста (onLayoutChanged), здесь — только версия.
    state.version += 1;
    return { status: 200, body: { version: state.version, graph_rev: scene.graph.graph_rev } };
  }
  return { status: 404, body: { detail: `Живая схема лендинга не отвечает на ${method} ${path}` } };
}

// Подменяет window.fetch для запросов к /api/v1 своего источника; прочее — настоящим fetch.
export function installStaticBackend(scene: LandingScene): void {
  const realFetch = window.fetch.bind(window);
  const state: StaticState = { version: scene.graph.version };
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = input instanceof Request ? input.url : String(input);
    const url = new URL(href, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith(`${API}/`)) {
      return realFetch(input, init);
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const reply = staticReply(scene, state, method, url);
    if (reply.status === 404) console.warn("[archmap-embed]", reply.body);
    return Promise.resolve(new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "Content-Type": "application/json" },
    }));
  };
}
