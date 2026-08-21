// ФАЗЗ-ПОЛИГОН РОУТЕРА (Ф0 эпика «глубокая оптимизация роутера»).
//
// Зачем: четыре эталонные сцены не покрывают углов, где ломаются правки класса А
// («маршруты байт-в-байт»): eps-схлоп грид-линий, направление реюза проходимости,
// тай-брейки кучи A*. Полигон гоняет buildAutoRoutes на сотнях СИНТЕТИЧЕСКИХ сцен,
// сводит результат в хэш и сравнивает с golden-файлом — любое изменение геометрии
// хоть на одном сиде роняет гейт с номером сида для воспроизведения.
//
// Детерминизм: генератор питается ТОЛЬКО mulberry32 от сида. Math.random и Date
// в этом файле запрещены — иначе golden не воспроизводится.
//
// Сцена собирается так, чтобы вход был ЛЕГАЛЕН для роутера (наложение тел друг на
// друга — нелегальный вход, его чинят другие стадии конвейера): узлы стоят по сетке,
// джиттер ограничен так, что тело всегда остаётся внутри своей ячейки с гарантированным
// зазором до соседних. Гарантированные паттерны в КАЖДОЙ сцене: веер-out, веер-in,
// встречная пара (рельсы E10), случайные пары; часть сцен получает раскрытые рамки и
// конец-рамку (E21a).
//
// Прогон одного сида — ДВА вызова buildAutoRoutes: чистый (проход 1 конвейера) и
// T4-подобный (prev от первого + плашки-препятствия + скоуп ~30% групп) — так гейт
// видит и гистерезис (E35), и штраф чужих плашек (E22), и preplaced-контекст.
import type { EdgePoint, LayoutEdge } from "../../types";
import type { EdgeGroup } from "../graph/types";
import { buildAutoRoutes, type AutoRoutesResult } from "../graph/layout/autoRoutes";
import type { RouteDump } from "../graph/layout/routeQualityMetrics";

export interface FuzzRect { x: number; y: number; w: number; h: number }

export interface FuzzFrame {
  id: string;
  rect: FuzzRect;
  plaque: FuzzRect;
  memberIds: Set<string>;
}

/** Полное описание сцены сида: вход обоих вызовов buildAutoRoutes. */
export interface FuzzScene {
  seed: number;
  groups: EdgeGroup[];
  routableIds: Set<string>;
  positions: Map<string, { x: number; y: number }>;
  displayIds: string[];
  sizes: Map<string, { w: number; h: number }>;
  frames: FuzzFrame[];
  frameEndpoints?: Map<string, FuzzRect>;
  /** Вход ВТОРОГО вызова (имитация T4-мини-прохода). */
  pass2: {
    routableIds: Set<string>;
    labelObstacles: Map<string, FuzzRect>;
  };
}

// ── PRNG ─────────────────────────────────────────────────────────────────────

/**
 * mulberry32 — 32-битный PRNG с полным периодом на сид. Единственный источник
 * случайности полигона (Math.random/Date запрещены: golden обязан воспроизводиться).
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── геометрия сцены ──────────────────────────────────────────────────────────

// Шаг сетки и минимальные зазоры. Инвариант: тело узла целиком лежит в своей ячейке,
// не ближе GAP_X/GAP_Y к соседней → наложений тел не бывает по построению.
// GAP_Y выбран больше нижнего поля рамки (FRAME_PAD_BOTTOM): плашка рамки нижнего
// ряда не может лечь на тело узла следующего ряда (иначе порты запирались бы и сцена
// уходила в лестницу клиренса — медленно и не про то).
const STEP_X = 300;
const STEP_Y = 220;
const GAP_X = 24;
const GAP_Y = 60;
const W_MIN = 150, W_MAX = 260;
const H_MIN = 80, H_MAX = 140;
const N_MIN = 8, N_MAX = 24;
// Поля раскрытой рамки вокруг её членов (низ шире — там живёт плашка подписи).
const FRAME_PAD = 16;
const FRAME_PAD_BOTTOM = 44;

const int = (rnd: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rnd() * (hi - lo + 1));

const pick = <T,>(rnd: () => number, arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)];

// Фишер–Йетс на том же PRNG: перебор кандидатов вееров в случайном, но
// воспроизводимом порядке (нужен, чтобы веер ГАРАНТИРОВАННО набрал 3–5 членов —
// повторный pick давал дубли пары и веер вырождался).
function shuffled<T>(rnd: () => number, arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Минимальный LayoutEdge-член группы: buildAutoRoutes читает у групп только
// id/source/target, но тип members честный (без any и без каста).
const memberEdge = (id: string, source: string, target: string): LayoutEdge => ({
  id,
  label: null,
  technology: null,
  source_id: source,
  target_id: target,
  version: 1,
  created_at: "2026-01-01T00:00:00Z",
});

/**
 * Синтетическая сцена по сиду: узлы на сетке с джиттером, гарантированные паттерны
 * рёбер, 0–2 раскрытые рамки, в части сцен — конец-рамка (E21a), плюс параметры
 * второго (T4-подобного) вызова.
 */
export function generateScene(seed: number): FuzzScene {
  const rnd = mulberry32(seed);

  // ── узлы ───────────────────────────────────────────────────────────────────
  const n = int(rnd, N_MIN, N_MAX);
  const cols = Math.ceil(Math.sqrt(n));
  const ids: string[] = [];
  const positions = new Map<string, { x: number; y: number }>();
  const sizes = new Map<string, { w: number; h: number }>();
  const rowOf = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const id = `n${String(i).padStart(2, "0")}`;
    const col = i % cols, row = Math.floor(i / cols);
    const w = int(rnd, W_MIN, W_MAX);
    const h = int(rnd, H_MIN, H_MAX);
    // джиттер строго внутри ячейки с зазором — наложений тел не бывает
    const jx = Math.round(rnd() * Math.max(0, STEP_X - w - GAP_X));
    const jy = Math.round(rnd() * Math.max(0, STEP_Y - h - GAP_Y));
    ids.push(id);
    positions.set(id, { x: col * STEP_X + jx, y: row * STEP_Y + jy });
    sizes.set(id, { w, h });
    rowOf.set(id, row);
  }

  // ── рёбра ──────────────────────────────────────────────────────────────────
  const groups: EdgeGroup[] = [];
  const taken = new Set<string>();          // «src->tgt» — точных дублей направления нет
  const addEdge = (source: string, target: string): boolean => {
    if (source === target) return false;
    const key = `${source}->${target}`;
    if (taken.has(key)) return false;
    taken.add(key);
    const id = `e${String(groups.length).padStart(2, "0")}`;
    groups.push({ id, source, target, members: [memberEdge(id, source, target)] });
    return true;
  };

  // веер OUT: один источник → 3–5 целей (общий порт-источник, легальный префикс E25)
  {
    const src = pick(rnd, ids);
    const k = int(rnd, 3, 5);
    let added = 0;
    for (const t of shuffled(rnd, ids)) {
      if (added >= k) break;
      if (addEdge(src, t)) added++;
    }
  }
  // веер IN: 3–5 источников → одна цель (общий порт-цель, легальный суффикс E25)
  {
    const tgt = pick(rnd, ids);
    const k = int(rnd, 3, 5);
    let added = 0;
    for (const s of shuffled(rnd, ids)) {
      if (added >= k) break;
      if (addEdge(s, tgt)) added++;
    }
  }
  // встречная пара (рельсы E10): нужна пара узлов, между которыми ещё нет связи
  for (let attempt = 0; attempt < 24; attempt++) {
    const a = pick(rnd, ids), b = pick(rnd, ids);
    if (a === b) continue;
    if (taken.has(`${a}->${b}`) || taken.has(`${b}->${a}`)) continue;
    addEdge(a, b);
    addEdge(b, a);
    break;
  }
  // случайные пары — фон сцены
  {
    const k = int(rnd, 6, Math.max(6, Math.round(n * 0.8)));
    for (let i = 0; i < k; i++) addEdge(pick(rnd, ids), pick(rnd, ids));
  }

  // ── раскрытые рамки ────────────────────────────────────────────────────────
  // Члены — СМЕЖНЫЕ узлы одного ряда: рамка тогда не накрывает посторонний узел, а её
  // плашка (нижняя полоса) гарантированно стоит в пустоте.
  const frames: FuzzFrame[] = [];
  const rows: string[][] = [];
  for (const id of ids) {
    const r = rowOf.get(id) ?? 0;
    (rows[r] ??= []).push(id);
  }
  const usedRows = new Set<number>();
  const nFrames = int(rnd, 0, 2);
  for (let f = 0; f < nFrames; f++) {
    const candidates = rows
      .map((members, row) => ({ members, row }))
      .filter((r) => r.members.length >= 2 && !usedRows.has(r.row));
    if (candidates.length === 0) break;
    const row = pick(rnd, candidates);
    usedRows.add(row.row);
    const size = Math.min(int(rnd, 2, 4), row.members.length);
    const start = int(rnd, 0, row.members.length - size);
    const members = row.members.slice(start, start + size);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of members) {
      const p = positions.get(id) ?? { x: 0, y: 0 };
      const s = sizes.get(id) ?? { w: W_MIN, h: H_MIN };
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + s.w); maxY = Math.max(maxY, p.y + s.h);
    }
    const rect: FuzzRect = {
      x: minX - FRAME_PAD,
      y: minY - FRAME_PAD,
      w: (maxX - minX) + 2 * FRAME_PAD,
      h: (maxY - minY) + FRAME_PAD + FRAME_PAD_BOTTOM,
    };
    const id = `f${f}`;
    const name = `Рамка ${id}`;
    // формула плашки рамки — из pipeline.ts (E21): x+10, y+h−30, w = min(w−20, 56+6.5·len)
    const plaque: FuzzRect = {
      x: rect.x + 10,
      y: rect.y + rect.h - 30,
      w: Math.min(rect.w - 20, 56 + 6.5 * name.length),
      h: 22,
    };
    frames.push({ id, rect, plaque, memberIds: new Set(members) });
  }

  // ── конец-рамка (E21a) в части сцен ────────────────────────────────────────
  let frameEndpoints: Map<string, FuzzRect> | undefined;
  if (frames.length > 0 && seed % 3 === 0) {
    const frame = frames[0];
    const outsiders = ids.filter((id) => !frame.memberIds.has(id));
    if (outsiders.length > 0) {
      const src = pick(rnd, outsiders);
      if (addEdge(src, frame.id)) {
        frameEndpoints = new Map([[frame.id, { ...frame.rect }]]);
      }
    }
  }

  // ── вход второго (T4-подобного) вызова ─────────────────────────────────────
  // Плашки: 3–8 прямоугольников на случайных группах, разбросанных по сцене.
  let sceneMaxX = 0, sceneMaxY = 0;
  for (const id of ids) {
    const p = positions.get(id) ?? { x: 0, y: 0 };
    const s = sizes.get(id) ?? { w: W_MIN, h: H_MIN };
    sceneMaxX = Math.max(sceneMaxX, p.x + s.w);
    sceneMaxY = Math.max(sceneMaxY, p.y + s.h);
  }
  const labelObstacles = new Map<string, FuzzRect>();
  const nLabels = Math.min(int(rnd, 3, 8), groups.length);
  const labelPool = groups.map((g) => g.id);
  for (let i = 0; i < nLabels; i++) {
    const gid = labelPool.splice(Math.floor(rnd() * labelPool.length), 1)[0];
    const w = int(rnd, 60, 160);
    const h = int(rnd, 20, 40);
    labelObstacles.set(gid, {
      x: Math.round(rnd() * Math.max(1, sceneMaxX - w)),
      y: Math.round(rnd() * Math.max(1, sceneMaxY - h)),
      w, h,
    });
  }
  // Скоуп ~30% групп — как T4 перепрокладывает только «грязные» рёбра.
  const scoped = new Set<string>();
  for (const g of groups) if (rnd() < 0.3) scoped.add(g.id);
  if (scoped.size === 0 && groups.length > 0) scoped.add(groups[0].id);

  return {
    seed,
    groups,
    routableIds: new Set(groups.map((g) => g.id)),
    positions,
    displayIds: ids,
    sizes,
    frames,
    frameEndpoints,
    pass2: { routableIds: scoped, labelObstacles },
  };
}

// ── прогон и хэш ─────────────────────────────────────────────────────────────

/** Глубокая копия результата: второй вызов не должен делить объекты с первым. */
function deepCopy(res: AutoRoutesResult): {
  routes: Map<string, EdgePoint[]>;
  handles: Map<string, { sourceHandle: string; targetHandle: string }>;
} {
  return {
    routes: new Map([...res.routes].map(([id, pts]) => [id, pts.map((p) => ({ x: p.x, y: p.y }))])),
    handles: new Map([...res.handles].map(([id, h]) => [id, { ...h }])),
  };
}

/**
 * Два вызова роутера на сцене: чистый проход и T4-подобный (prev + плашки + скоуп).
 * prev второму вызову передаётся ГЛУБОКОЙ копией — вызовы не делят объекты
 * (buildAutoRoutes мутирует ломаные раздачей слотов и сваркой).
 */
export function runScene(scene: FuzzScene): { pass1: AutoRoutesResult; pass2: AutoRoutesResult } {
  const base = {
    groups: scene.groups,
    positions: scene.positions,
    displayIds: scene.displayIds,
    sizes: scene.sizes,
    frames: scene.frames,
    frameEndpoints: scene.frameEndpoints,
  };
  const pass1 = buildAutoRoutes({ ...base, routableIds: scene.routableIds });
  const pass2 = buildAutoRoutes({
    ...base,
    routableIds: scene.pass2.routableIds,
    prev: deepCopy(pass1),
    labelObstacles: scene.pass2.labelObstacles,
  });
  return { pass1, pass2 };
}

const byKey = (a: readonly [string, unknown], b: readonly [string, unknown]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

/**
 * Детерминированная сериализация результата: маршруты и хэндлы отсортированы по id
 * (порядок итерации Map не участвует), координаты — полной точностью (String(n) даёт
 * кратчайшее round-trip представление, −0 печатается как 0).
 */
export function serializeResult(res: AutoRoutesResult): string {
  const routes = [...res.routes.entries()].sort(byKey)
    .map(([id, pts]) => `${id}=${pts.map((p) => `${p.x},${p.y}`).join(";")}`);
  const handles = [...res.handles.entries()].sort(byKey)
    .map(([id, h]) => `${id}=${h.sourceHandle}>${h.targetHandle}`);
  return `R\n${routes.join("\n")}\nH\n${handles.join("\n")}`;
}

/** FNV-1a 32 бита, hex. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** djb2 32 бита, hex — вторая половина ключа (шире 32 бит: случайная коллизия исключена). */
export function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Хэш сериализации (16 hex = FNV-1a ⧺ djb2). */
export function hashOf(s: string): string {
  return fnv1a(s) + djb2(s);
}

/** Полный прогон сида: сцена → два вызова → хэш обоих результатов. */
export function runSeed(seed: number): string {
  const scene = generateScene(seed);
  const { pass1, pass2 } = runScene(scene);
  return hashOf(`P1\n${serializeResult(pass1)}\nP2\n${serializeResult(pass2)}`);
}

/**
 * Дамп сцены в формате метрик качества (routeQualityMetrics.RouteDump) — чтобы
 * полигон умел не только «байт-в-байт», но и числовой замер качества.
 * labels — ВСЕГДА плашки второго прохода: для маршрутов прохода 1 это замер
 * «сколько грязи увидит T4», для прохода 2 — сколько её осталось.
 */
export function sceneDump(scene: FuzzScene, res: AutoRoutesResult): RouteDump {
  const rects = scene.displayIds.flatMap((id) => {
    const p = scene.positions.get(id);
    const s = scene.sizes.get(id);
    return p && s ? [{ id, x: p.x, y: p.y, w: s.w, h: s.h }] : [];
  });
  // плашки раскрытых рамок — тоже жёсткие препятствия (E21), но у них нет группы:
  // в дамп кладём их телами, чтобы «сквозь тела» видело и их
  for (const f of scene.frames) rects.push({ id: `plaque:${f.id}`, ...f.plaque });
  return {
    routes: [...res.routes.entries()].sort(byKey).map(([id, pts]) => [id, pts.map((p) => ({ x: p.x, y: p.y }))]),
    rects,
    labels: [...scene.pass2.labelObstacles.entries()].sort(byKey).map(([id, r]) => [id, { ...r }]),
  };
}
