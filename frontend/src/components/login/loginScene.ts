// Сцена превью на странице входа: кадр анимации по t∈[0,1] — чистая функция.
// t=0 — контейнер «Сервис заказов» свёрнут, t=1 — раскрыт в рамку с детьми.
// Геометрия и подписи — из принятого прототипа страницы входа; цвета узлов и связей —
// из палитры холста (graph/colors.ts), чтобы картинка совпадала с редактором.
// Это картинка, а не холст: ни React Flow, ни движок раскладки сюда не тянем.
import { getNodeColors, STATUS_META } from "../graph/colors";
import type { NodeColors } from "../graph/types";

export type Point = readonly [number, number];

export interface SceneBox { x: number; y: number; w: number; h: number }

/** Обычный узел-сервис: заливка, имя, плашка технологии. */
export interface SceneService { name: string; tag: string; x: number; y: number; colors: NodeColors }

/** Свёрнутый контейнер (пунктир, «контейнер», лупа) — сам «Сервис заказов» или его дети. */
export interface SceneContainer { name: string; box: SceneBox; colors: NodeColors; alpha: number }

/** Рамка раскрытого контейнера: серый пунктир и плашка с именем внизу слева. */
export interface SceneFrameBox { name: string; box: SceneBox; alpha: number }

/** Ортогональная связь с подписью на белой плашке (строки подписи — сверху вниз). */
export interface SceneEdge { id: string; points: Point[]; label: string[]; at: Point; alpha: number }

/** Кадр: только видимое (alpha > 0). Порядок отрисовки — связи, сервисы, рамка,
 *  свёрнутый контейнер, дети. */
export interface SceneFrame {
  edges: SceneEdge[];
  services: SceneService[];
  frame: SceneFrameBox | null;
  container: SceneContainer | null;
  children: SceneContainer[];
}

// Размер узла на сцене.
export const SCENE_NODE_W = 150;
export const SCENE_NODE_H = 78;
// Окно сцены (viewBox): подобрано в прототипе под обе фазы с запасом на тени.
export const SCENE_VIEWBOX = "-12 34 784 346";

// Цвет связи — цвет существующей связи на холсте; узлы — рампа C4 по глубине:
// «Сервис заказов» и шлюз — глубина 1, дети раскрытого — глубина 2, внешний — 0.
export const SCENE_EDGE_COLOR = STATUS_META.existing.edge;
const DEPTH1 = getNodeColors(false, 1);
const DEPTH2 = getNodeColors(false, 2);
const EXTERNAL = getNodeColors(true, 0);

const ORDER_SERVICE = "Сервис заказов";
const ROW_Y = 161; // верх ряда «шлюз — сервис — доставка»
const MID_Y = ROW_Y + SCENE_NODE_H / 2; // уровень горизонтальных связей

// Два состояния: свёрнуто / раскрыто. Соседи раздвигаются, контейнер становится рамкой.
const COLLAPSED = { gateway: 40, delivery: 570, box: { x: 305, y: ROW_Y, w: SCENE_NODE_W, h: SCENE_NODE_H } };
const EXPANDED = { gateway: 0, delivery: 610, box: { x: 240, y: 48, w: 280, h: 318 } };
const KIDS = [
  { name: "Order API", x: 262, y: 80 },
  { name: "Оркестратор", x: 352, y: 212 },
] as const;

const CHECKOUT = ["Оформление", "заказа · REST"];
const SHIPMENT = ["Создание", "отправки · REST"];
const ORDER_EVENTS = ["События", "заказа · Kafka"];

// Смена содержимого в середине перехода: старое гаснет к FADE_OUT_END, новое
// проявляется с FADE_IN_START; между ними видна только морфящаяся рамка.
const FADE_OUT_END = 0.45;
const FADE_IN_START = 0.55;

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Кадр сцены по t∈[0,1] (вне отрезка — прижимается к краю). Морф рамки идёт всю
 *  длину перехода, смена содержимого — в середине: связи и свёрнутый контейнер
 *  гаснут до t=0.45, дети и связи раскрытого вида проявляются после t=0.55. */
export function sceneFrame(tRaw: number): SceneFrame {
  const t = Math.min(1, Math.max(0, tRaw));
  const gw = lerp(COLLAPSED.gateway, EXPANDED.gateway, t);
  const dl = lerp(COLLAPSED.delivery, EXPANDED.delivery, t);
  const b: SceneBox = {
    x: lerp(COLLAPSED.box.x, EXPANDED.box.x, t),
    y: lerp(COLLAPSED.box.y, EXPANDED.box.y, t),
    w: lerp(COLLAPSED.box.w, EXPANDED.box.w, t),
    h: lerp(COLLAPSED.box.h, EXPANDED.box.h, t),
  };
  // Знаменатель late — (1 − FADE_IN), а не 0.45: в плавающей точке иначе при t=1
  // выходит 0.999…, и раскрытый кадр не совпадает с конечным байт-в-байт.
  const early = Math.max(0, 1 - t / FADE_OUT_END);
  const late = Math.max(0, (t - FADE_IN_START) / (1 - FADE_IN_START));
  const W = SCENE_NODE_W;
  const H = SCENE_NODE_H;

  const edges: SceneEdge[] = [];
  // Связи свёрнутого вида: в бока контейнера.
  if (early > 0) {
    edges.push(
      { id: "checkout", points: [[gw + W, MID_Y], [b.x, MID_Y]], label: CHECKOUT,
        at: [(gw + W + b.x) / 2, MID_Y], alpha: early },
      { id: "shipment", points: [[b.x + b.w, MID_Y], [dl, MID_Y]], label: SHIPMENT,
        at: [(b.x + b.w + dl) / 2, MID_Y], alpha: early },
    );
  }
  // Связи раскрытого вида: к дочерним контейнерам и между ними.
  if (late > 0) {
    const [api, orch] = KIDS;
    edges.push(
      { id: "checkout-api",
        points: [[gw + W, MID_Y], [234, MID_Y], [234, api.y + H / 2], [api.x, api.y + H / 2]],
        label: CHECKOUT, at: [gw + W + 40, MID_Y], alpha: late },
      { id: "api-orchestrator",
        points: [[300, api.y + H], [300, orch.y + H / 2], [orch.x, orch.y + H / 2]],
        label: ORDER_EVENTS, at: [300, (api.y + H + orch.y + H / 2) / 2 + 4], alpha: late },
      { id: "orchestrator-shipment",
        points: [[orch.x + W, orch.y + H / 2], [586, orch.y + H / 2], [586, MID_Y], [dl, MID_Y]],
        label: SHIPMENT, at: [orch.x + W + 42, orch.y + H / 2], alpha: late },
    );
  }

  return {
    edges,
    services: [
      { name: "API Gateway", tag: "шлюз: Kong", x: gw, y: ROW_Y, colors: DEPTH1 },
      { name: "Служба доставки", tag: "внешний: REST API", x: dl, y: ROW_Y, colors: EXTERNAL },
    ],
    frame: t > 0 ? { name: ORDER_SERVICE, box: b, alpha: Math.min(1, t * 2.2) } : null,
    container: early > 0 ? { name: ORDER_SERVICE, box: b, colors: DEPTH1, alpha: early } : null,
    children: late > 0
      ? KIDS.map((k) => ({ name: k.name, box: { x: k.x, y: k.y, w: W, h: H }, colors: DEPTH2, alpha: late }))
      : [],
  };
}

/** Путь ортогональной ломаной со скруглёнными (квадратичными) изломами радиуса r. */
export function roundedPath(points: readonly Point[], r = 8): string {
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [x, y] = points[i];
    if (i < points.length - 1) {
      const [px, py] = points[i - 1];
      const [nx, ny] = points[i + 1];
      const ax = x - Math.sign(x - px) * r;
      const ay = y - Math.sign(y - py) * r;
      const bx = x + Math.sign(nx - x) * r;
      const by = y + Math.sign(ny - y) * r;
      d += ` L${ax},${ay} Q${x},${y} ${bx},${by}`;
    } else {
      d += ` L${x},${y}`;
    }
  }
  return d;
}

// ── Цикл анимации ────────────────────────────────────────────────────────────
// Каждые 3 с сцена меняет состояние: свёрнуто → раскрыто → свёрнуто…; переход 0.8 с
// в начале каждого окна.
export const SCENE_PERIOD_MS = 3000;
export const SCENE_MOVE_MS = 800;

/** Плавный разгон и торможение (ease-in-out cubic): 0→0, 1→1. */
export function easeInOutCubic(k: number): number {
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

/** t кадра по времени с начала показа. Старт — с уже свёрнутого кадра (сдвиг на
 *  длину перехода): первый кадр совпадает со статичным t=0 и не прыгает. */
export function sceneTAt(elapsedMs: number): number {
  const ms = (Math.max(0, elapsedMs) + SCENE_MOVE_MS) % (SCENE_PERIOD_MS * 2);
  const open = ms >= SCENE_PERIOD_MS; // вторая половина цикла — раскрыто
  const k = Math.min(1, (ms % SCENE_PERIOD_MS) / SCENE_MOVE_MS);
  return open ? easeInOutCubic(k) : 1 - easeInOutCubic(k);
}
