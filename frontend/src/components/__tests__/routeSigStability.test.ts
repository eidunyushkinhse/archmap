import { describe, it, expect } from "vitest";
import { computeViewLayout, type PipelineInput } from "../graph/layout/pipeline";
import { __clearElkCacheForTests } from "../graph/layout/engine";
import type { Node as AppNode, Edge as AppEdge } from "../../types";

// ПОБИТОВОСТЬ routeSig МЕЖДУ ПРОГОНАМИ (Ф0 эпика «глубокая оптимизация роутера»).
// Кэш финальных маршрутов вида (кандидат Б1) хитует по routeSig: если два прогона
// одного и того же входа дают РАЗНЫЕ сигнатуры, кэш не хитует никогда, а если дают
// одинаковую сигнатуру при разных маршрутах — кэш отдаёт чужой результат. Здесь
// проверяется первое: сигнатура и маршруты идентичного входа воспроизводятся.
//
// Профиль сцены — «viewer»: сохранённых позиций в viewLayout НЕТ, всю сцену
// раскладывает ELK (у зрителя засев владения гейтится, и так выглядит каждое его
// открытие уровня). Между прогонами кэш ELK СБРАСЫВАЕТСЯ — иначе второй прогон
// брал бы позиции из кэша и тест проверял бы меньше, чем «между сессиями».

function appNode(id: string): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id: "P", shape: "service", is_external: false, status: "existing",
    openapi_spec: null, docs: [], version: 1,
    created_at: "", updated_at: "", has_children: false, child_count: 0,
  } as AppNode;
}

function edge(id: string, source_id: string, target_id: string, label: string | null): AppEdge {
  return {
    id, label, technology: null, source_id, target_id,
    created_at: "2026-08-21T00:00:00Z",
  } as AppEdge;
}

// 7 узлов, 9 связей: цепочка с хордами — маршрутам есть где разойтись, плашкам есть
// на что налезть (мини-проход T4 отрабатывает), а формой сцена не «звезда» (N30).
const NODE_IDS = ["A", "B", "C", "D", "E", "F", "G"];
const EDGES: [string, string, string, string | null][] = [
  ["e1", "A", "B", "зов"],
  ["e2", "B", "C", "публикация события"],
  ["e3", "C", "D", null],
  ["e4", "D", "E", "выборка"],
  ["e5", "E", "F", null],
  ["e6", "F", "G", "уведомление"],
  ["e7", "A", "D", "синхронизация справочников"],
  ["e8", "B", "E", null],
  ["e9", "C", "F", "метрики"],
];

function scene(): PipelineInput {
  return {
    nodes: NODE_IDS.map(appNode),
    endpoints: [],
    edges: EDGES.map(([id, s, t, l]) => edge(id, s, t, l)),
    containerId: "P",
    viewLayout: {},              // viewer-профиль: ничего не владеется, всё считает ELK
    ancestorIds: ["P"],
    expanded: new Set<string>(),
    localChildren: {},
    // Габариты есть у ВСЕХ узлов: прогон полный (авто-порог P10 не пропускает
    // стадии качества), маршруты считаются по настоящим телам.
    sizes: Object.fromEntries(NODE_IDS.map((id, i) => [id, { w: i % 2 === 0 ? 190 : 240, h: i % 3 === 0 ? 100 : 120 }])),
    edgeQuality: "full",
  };
}

// Глубокая копия входа: конвейер получает свежие объекты, а не общие ссылки —
// иначе «идентичность» прогонов могла бы держаться на мутации общего входа.
function clone(i: PipelineInput): PipelineInput {
  return {
    ...i,
    nodes: i.nodes.map((n) => ({ ...n })),
    endpoints: i.endpoints.map((e) => ({ ...e })),
    edges: i.edges.map((e) => ({ ...e })),
    viewLayout: JSON.parse(JSON.stringify(i.viewLayout)) as PipelineInput["viewLayout"],
    ancestorIds: [...i.ancestorIds],
    expanded: new Set(i.expanded),
    localChildren: { ...i.localChildren },
    sizes: i.sizes ? JSON.parse(JSON.stringify(i.sizes)) as PipelineInput["sizes"] : undefined,
  };
}

describe("routeSig — побитовость между идентичными прогонами (viewer-профиль)", () => {
  it("два прогона одного входа со сброшенным кэшем ELK: sig и маршруты идентичны", async () => {
    const input = scene();

    __clearElkCacheForTests();
    const first = await computeViewLayout(clone(input));
    __clearElkCacheForTests(); // без сброса второй прогон взял бы ELK из кэша
    const second = await computeViewLayout(clone(input));

    // прогон был полным: маршруты посчитаны у всех девяти групп
    expect(first.routeSig.length).toBeGreaterThan(0);
    expect(first.layout.autoRoutes?.size).toBe(EDGES.length);
    for (const [, pts] of first.layout.autoRoutes ?? []) expect(pts.length).toBeGreaterThanOrEqual(2);

    // сигнатура — строго та же строка
    expect(second.routeSig).toBe(first.routeSig);

    // и сами маршруты — поточечно (сигнатура без этого равенства бесполезна: кэш
    // маршрутов хитует по ней и обязан отдавать ровно то, что посчитал бы прогон)
    const dump = (r?: Map<string, { x: number; y: number }[]>): [string, { x: number; y: number }[]][] =>
      [...(r ?? new Map<string, { x: number; y: number }[]>())].sort(([a], [b]) => a.localeCompare(b));
    expect(dump(second.layout.autoRoutes)).toEqual(dump(first.layout.autoRoutes));
  });
});
