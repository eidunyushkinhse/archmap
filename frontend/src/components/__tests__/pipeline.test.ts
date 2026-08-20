import { describe, it, expect } from "vitest";
import { computeViewLayout, buildRouteSig, type LayoutResult, type PipelineInput } from "../graph/layout/pipeline";
import type { Node as AppNode, Edge as AppEdge, GhostNode, AncestorRef } from "../../types";
import { NODE_W, NODE_H } from "../graph/constants";

// Характеризация КОМПОЗИЦИИ конвейера раскладки (R1/R3): отдельные стадии покрыты
// своими тестами, здесь — сквозные инварианты целого: детерминизм, засев владения
// интентами (а не записью в БД), конвергенция «второй прогон с засеянными позициями —
// no-op», слияние мастеров, геометрия по ключу пучка, контекст-режим без интентов.

const a = (id: string): AncestorRef => ({ id, name: id, is_external: false });

function appNode(id: string): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id: "P", shape: "service", is_external: false, status: "existing",
    openapi_spec: null, docs: [], version: 1,
    created_at: "", updated_at: "", has_children: false, child_count: 0,
  } as AppNode;
}

function ghost(id: string, ancestors: AncestorRef[]): GhostNode {
  return {
    id, name: id, role: null, technology: null, is_external: true,
    shape: "service", status: "existing", node_depth: ancestors.length,
    has_children: false, child_count: 0, ancestors, is_ghost: true,
  } as GhostNode;
}

function edge(id: string, source_id: string, target_id: string, label: string | null = null): AppEdge {
  return {
    id, label, technology: null, source_id, target_id,
    created_at: "2026-07-07T00:00:00Z",
  } as AppEdge;
}

// Базовая сцена уровня (сырьё R2/R3): два локала — дети контейнера P — с владеемыми
// позициями в viewLayout; рёбра с РЕАЛЬНЫМИ концами; в реестре endpoints — внешний
// корневой лист G и H под чужим корнем D (свернётся в контейнер D). Гости требуют засева.
function levelInput(overrides: Partial<PipelineInput> = {}): PipelineInput {
  return {
    nodes: [appNode("A"), appNode("B")],
    endpoints: [ghost("G", []), ghost("H", [a("D")])],
    edges: [edge("eAB", "A", "B", "зов"), edge("eGA", "G", "A"), edge("eHB", "H", "B")],
    containerId: "P",
    viewLayout: { A: { x: 0, y: 0 }, B: { x: 400, y: 0 } },
    ancestorIds: ["P"],
    expanded: new Set(),
    localChildren: {},
    // Тесты композиции гоняют ПОЛНЫЙ конвейер: без замеров авто-режим P10
    // пропускал бы стадии качества (см. отдельный describe авто-режима).
    edgeQuality: "full",
    ...overrides,
  };
}

// Точка лежит НА границе прямоугольника (стыковка конца-в-рамку): совпадает с одной из
// сторон и не выходит за её створ. Допуск 0.5 — тот же EPS, что у роутера.
function onRectBorder(p: { x: number; y: number }, r: { x: number; y: number; w: number; h: number }): boolean {
  const E = 0.5;
  const inX = p.x >= r.x - E && p.x <= r.x + r.w + E;
  const inY = p.y >= r.y - E && p.y <= r.y + r.h + E;
  const onV = (Math.abs(p.x - r.x) <= E || Math.abs(p.x - (r.x + r.w)) <= E) && inY;
  const onH = (Math.abs(p.y - r.y) <= E || Math.abs(p.y - (r.y + r.h)) <= E) && inX;
  return onV || onH;
}

// Стабильная сериализация раскладки (Map → отсортированные пары) для сравнения прогонов.
function sig(l: LayoutResult): string {
  const m = (x?: Map<string, unknown>) => (x ? [...x.entries()].sort((p, q) => p[0].localeCompare(q[0])) : null);
  return JSON.stringify({
    pos: m(l.positions),
    handles: m(l.edgeHandles),
    routes: m(l.autoRoutes),
    labels: m(l.labelPlacements),
    groups: l.groupArr.map((g) => ({ id: g.id, n: g.members.length })).sort((p, q) => p.id.localeCompare(q.id)),
  });
}

describe("computeViewLayout — композиция конвейера уровня", () => {
  it("позиции у всех сущностей, маршруты у всех групп, засев гостей — интентами", async () => {
    const out = await computeViewLayout(levelInput());
    // сущности: гость-лист G и контейнер D (H свёрнут в предка)
    expect(out.layout.entities.map((e) => e.id).sort()).toEqual(["D", "G"]);
    for (const id of ["A", "B", "G", "D"]) expect(out.layout.positions.get(id)).toBeTruthy();
    // сохранённые позиции локалов (viewLayout) уважены — не пересчитаны ELK
    expect(out.layout.positions.get("A")).toEqual({ x: 0, y: 0 });
    expect(out.layout.positions.get("B")).toEqual({ x: 400, y: 0 });
    // все три группы рёбер получили авто-маршрут (ручных правок нет)
    expect(out.layout.groupArr.map((g) => g.id).sort()).toEqual(["eAB", "eGA", "eHB"]);
    for (const g of out.layout.groupArr) {
      expect(out.layout.autoRoutes?.get(g.id)?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
    // засев владения пришёл интентом (никаких вызовов персиста из конвейера)
    const seeds = out.intents.filter((i) => i.kind === "seed-positions").flatMap((i) => i.seeds);
    expect(seeds.map((s) => s.id).sort()).toEqual(["D", "G"]);
    // liveInputs согласованы с раскладкой
    expect(out.liveInputs.localIds).toEqual(new Set(["A", "B"]));
    expect(out.liveInputs.layoutEdges.map((e) => e.id).sort()).toEqual(["eAB", "eGA", "eHB"]);
  });

  it("V22: невладеемые ЛОКАЛЫ засеиваются при первом показе (стабильность холста)", async () => {
    // уровень без сохранённых строк: локалы A/B засеиваются вместе с гостями —
    // иначе ELK пере-размещал бы их при каждом изменении графа
    const out = await computeViewLayout(levelInput({ viewLayout: {} }));
    const seeds = out.intents.filter((i) => i.kind === "seed-positions").flatMap((i) => i.seeds);
    expect(seeds.map((s) => s.id).sort()).toEqual(["A", "B", "D", "G"]);
  });

  it("стабильность: добавление узла и связи не двигает владеемых локалов", async () => {
    const first = await computeViewLayout(levelInput());
    const posA = first.layout.positions.get("A");
    const posB = first.layout.positions.get("B");
    // новый узел C + связь с ним: A/B владеемые → остаются на местах
    const second = await computeViewLayout(levelInput({
      nodes: [appNode("A"), appNode("B"), appNode("C")],
      edges: [
        edge("eAB", "A", "B", "зов"), edge("eGA", "G", "A"), edge("eHB", "H", "B"),
        edge("eAC", "A", "C"),
      ],
    }));
    expect(second.layout.positions.get("A")).toEqual(posA);
    expect(second.layout.positions.get("B")).toEqual(posB);
    // новичок C невладеемый → засеян (зафиксируется и дальше двигать не будет)
    const seeds = second.intents.filter((i) => i.kind === "seed-positions").flatMap((i) => i.seeds);
    expect(seeds.map((s) => s.id)).toContain("C");
  });

  it("конвергенция: второй прогон с засеянными позициями — без интентов и без сдвигов", async () => {
    const first = await computeViewLayout(levelInput());
    const seeded = Object.fromEntries(
      first.intents
        .filter((i) => i.kind === "seed-positions")
        .flatMap((i) => i.seeds)
        .map((s) => [s.id, { x: s.x, y: s.y }]),
    );
    const second = await computeViewLayout(
      levelInput({ viewLayout: { A: { x: 0, y: 0 }, B: { x: 400, y: 0 }, ...seeded } }),
    );
    expect(second.intents).toEqual([]);
    expect(sig(second.layout)).toBe(sig(first.layout));
  });

  it("детерминизм: два одинаковых прогона дают идентичную раскладку", async () => {
    const [r1, r2] = await Promise.all([computeViewLayout(levelInput()), computeViewLayout(levelInput())]);
    expect(sig(r1.layout)).toBe(sig(r2.layout));
  });

  it("две связи одного направления сливаются в мастер-группу merge:", async () => {
    const inp = levelInput({
      edges: [edge("e1", "A", "B", "раз"), edge("e2", "A", "B", "два")],
      endpoints: [],
    });
    const out = await computeViewLayout(inp);
    expect(out.layout.groupArr).toHaveLength(1);
    expect(out.layout.groupArr[0].id).toBe("merge:A->B");
    expect(out.layout.groupArr[0].members.map((m) => m.id).sort()).toEqual(["e1", "e2"]);
  });

  it("R5: раскрытый ЛОКАЛ заменяется детьми, рамка в guestFrames, концы поднимаются к детям", async () => {
    // B раскрыт: вместо него — дети B1/B2; ребро A→(внук под B1... сам B1) идёт к B1;
    // ребро от G к B поднимается... G→A остаётся; внутреннее B1→B2 видно.
    const b1 = { ...appNode("B1"), parent_id: "B" } as AppNode;
    const b2 = { ...appNode("B2"), parent_id: "B" } as AppNode;
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAB1", "A", "B1", "к ребёнку"), edge("eB1B2", "B1", "B2", "внутри")],
      endpoints: [
        // реестр не-локальных концов: B1/B2 глубокие внутри поддерева уровня
        { ...ghost("B1", [a("P"), a("B")]), is_external: false },
        { ...ghost("B2", [a("P"), a("B")]), is_external: false },
      ],
      expanded: new Set(["B"]),
      localChildren: { B: [b1, b2] },
    }));
    // B замещён детьми
    expect(out.layout.nodes.map((n) => n.id).sort()).toEqual(["A", "B1", "B2"]);
    // рамка раскрытого локала B — compound с обоими детьми
    const bf = out.layout.guestFrames.find((f) => f.id === "B");
    expect(bf).toBeTruthy();
    expect([...bf!.memberIds].sort()).toEqual(["B1", "B2"]);
    // рёбра: A→B1 (конец-ребёнок локален) и внутреннее B1→B2 видны
    expect(out.layout.groupArr.map((g) => g.id).sort()).toEqual(["eAB1", "eB1B2"]);
    // дети засеяны интентом (own-on-first-render сетки первого показа)
    const seeds = out.intents.filter((i) => i.kind === "seed-positions").flatMap((i) => i.seeds);
    expect(seeds.map((s) => s.id).sort()).toEqual(expect.arrayContaining(["B1", "B2"]));
  });

  it("связь «прямо в раскрытый контейнер» упирается наконечником в его рамку", async () => {
    // Все связи ребёнка ведут в сам раскрытый контейнер (типично для свежей схемы:
    // пользователь протянул связь к контейнеру, а не к его будущим детям). До эпика
    // «связи, упирающиеся в рамку» проекция такую связь ДРОПАЛА, и от неё на схеме
    // оставался только висящий сосед; теперь конец — сама рамка (её id = id узла).
    const b1 = { ...appNode("B1"), parent_id: "B" } as AppNode;
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAB", "A", "B", "в контейнер")],
      endpoints: [],
      viewLayout: { A: { x: 0, y: 0 }, B: { x: 400, y: 0 } },
      expanded: new Set(["B"]),
      localChildren: { B: [b1] },
    }));
    // связь видна, её конец — контейнер B (он же рамка)
    expect(out.layout.groupArr.map((g) => [g.id, g.source, g.target])).toEqual([["eAB", "A", "B"]]);
    // ребёнок сел от owned-позиции контейнера (сетка 1×1 = ровно его угол)
    expect(out.layout.positions.get("B1")).toEqual({ x: 400, y: 0 });
    // рамка раскрытия обнимает ребёнка на месте контейнера
    const bf = out.layout.guestFrames.find((f) => f.id === "B")!;
    expect(bf).toBeTruthy();
    expect([...bf.memberIds]).toEqual(["B1"]);
    expect(bf.rect.x).toBeLessThan(400);
    expect(bf.rect.y).toBeLessThan(0);
    expect(bf.rect.x + bf.rect.w).toBeGreaterThan(400 + 190);
    // маршрут кончается НА ГРАНИЦЕ рамки — не в её центре и не внутри
    const route = out.layout.autoRoutes?.get("eAB");
    expect(route?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(onRectBorder(route![route!.length - 1], bf.rect)).toBe(true);
    // и засеян интентом — раскрытие персистит место навсегда
    const seeds = out.intents.filter((i) => i.kind === "seed-positions").flatMap((i) => i.seeds);
    expect(seeds.map((s) => s.id)).toContain("B1");
  });

  it("R5-инвариант: чужой узел не остаётся внутри рамки раскрытого локала", async () => {
    // A владеет позицией ровно там, где раскроется B (сетка детей от позиции B=400,0) —
    // конвейер обязан вытолкнуть A за rect рамки.
    const b1 = { ...appNode("B1"), parent_id: "B" } as AppNode;
    const b2 = { ...appNode("B2"), parent_id: "B" } as AppNode;
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAB1", "A", "B1", "к ребёнку")],
      endpoints: [{ ...ghost("B1", [a("P"), a("B")]), is_external: false }],
      viewLayout: { A: { x: 420, y: 20 }, B: { x: 400, y: 0 } },
      expanded: new Set(["B"]),
      localChildren: { B: [b1, b2] },
    }));
    const bf = out.layout.guestFrames.find((f) => f.id === "B")!;
    const pa = out.layout.positions.get("A")!;
    const overlapsFrame =
      pa.x < bf.rect.x + bf.rect.w && pa.x + 180 > bf.rect.x &&
      pa.y < bf.rect.y + bf.rect.h && pa.y + 70 > bf.rect.y;
    expect(overlapsFrame).toBe(false);
    // члены рамки на местах сетки (рамка пиннится, уступает чужак)
    for (const id of ["B1", "B2"]) {
      const p = out.layout.positions.get(id)!;
      expect(
        p.x >= bf.content.minX - 1 && p.y >= bf.content.minY - 1,
      ).toBe(true);
    }
  });

  it("каскад догрузки вложенных: волна внуков НЕ двигает уже разложенных детей (стабильность анимации)", async () => {
    // B раскрыт, его ребёнок B2 тоже раскрыт (персист). Волна А: дети B догружены,
    // внуки B2 ещё нет (B2 остаётся узлом). Волна Б: внуки пришли, B2 стал рамкой.
    // До фикса подграф спавна собирался из ЛИСТЬЕВ — состав менялся (B2 → внуки),
    // мини-ELK перекладывал всё, дети прыгали на сотни px. Теперь подграф — прямые
    // дети (B2 узлом в обеих волнах): позиции b1/b3 совпадают волна-к-волне, внук
    // ложится от позиции B2 из группы родителя.
    const b1 = { ...appNode("B1"), parent_id: "B" } as AppNode;
    const b2 = { ...appNode("B2"), parent_id: "B", has_children: true, child_count: 1 } as AppNode;
    const b3 = { ...appNode("B3"), parent_id: "B" } as AppNode;
    const c1 = { ...appNode("C1"), parent_id: "B2" } as AppNode;
    const waveA = await computeViewLayout(levelInput({
      edges: [
        edge("e12", "B1", "B2", "поток"),
        edge("e23", "B2", "B3", "дальше"),
        edge("eAB1", "A", "B1", "внешний зов"),
      ],
      endpoints: [],
      viewLayout: { A: { x: 0, y: 300 }, B: { x: 400, y: 0 } },
      expanded: new Set(["B", "B2"]),
      localChildren: { B: [b1, b2, b3] }, // внуки B2 ещё не догружены
    }));
    const waveB = await computeViewLayout(levelInput({
      edges: [
        edge("e12", "B1", "C1", "поток"),      // реальные концы глубокие
        edge("e23", "C1", "B3", "дальше"),
        edge("eAB1", "A", "B1", "внешний зов"),
      ],
      endpoints: [],
      viewLayout: { A: { x: 0, y: 300 }, B: { x: 400, y: 0 } },
      expanded: new Set(["B", "B2"]),
      localChildren: { B: [b1, b2, b3], B2: [c1] },
    }));
    // дети B стоят там же, где их положила волна А
    for (const id of ["B1", "B3"]) {
      expect(waveB.layout.positions.get(id)).toEqual(waveA.layout.positions.get(id));
    }
    // внук лёг от позиции своего контейнера (волна А клала туда узел B2)
    expect(waveB.layout.positions.get("C1")).toEqual(waveA.layout.positions.get("B2"));
  });

  it("R5-предел (C8): инлайн-раскрытие не глубже MAX_INLINE_DEPTH=2 — узел на глубине 2 свёрнут, глубина 3 не видна", async () => {
    // Цепочка B (локал уровня, глубина 0) → B2 (1) → C1 (2) → D1 (3); ВСЕ раскрыты
    // персистно и дети догружены. Предел 2: B и B2 раскрываются (дети на глубине 1
    // и 2 видны), C1 на глубине 2 инлайн НЕ раскрывается — остаётся узлом, хотя
    // expanded и дети [D1] догружены; D1 (глубина 3) не показывается вовсе.
    // Рендерер не строит рамки глубже лимита даже на персистно раскрытой сцене.
    const b2 = { ...appNode("B2"), parent_id: "B", has_children: true, child_count: 1 } as AppNode;
    const c1 = { ...appNode("C1"), parent_id: "B2", has_children: true, child_count: 1 } as AppNode;
    const d1 = { ...appNode("D1"), parent_id: "C1" } as AppNode;
    const out = await computeViewLayout(levelInput({
      edges: [],
      endpoints: [],
      viewLayout: { A: { x: 0, y: 0 }, B: { x: 400, y: 0 } },
      expanded: new Set(["B", "B2", "C1"]),
      localChildren: { B: [b2], B2: [c1], C1: [d1] },
    }));
    // B и B2 поглощены раскрытием (стали рамками); C1 остался УЗЛОМ (предел глубины),
    // D1 не показан. A — обычный локал.
    expect(out.layout.nodes.map((n) => n.id).sort()).toEqual(["A", "C1"]);
    // Рамки — только раскрытые B и B2; C1 (глубина 2, не раскрыт) рамкой не стал.
    expect(out.layout.guestFrames.map((f) => f.id).sort()).toEqual(["B", "B2"]);
    // C1 — член самой глубокой раскрытой рамки B2.
    const b2f = out.layout.guestFrames.find((f) => f.id === "B2")!;
    expect([...b2f.memberIds]).toContain("C1");
    // D1 нигде не отображён: ни член рамки, ни позиция.
    for (const f of out.layout.guestFrames) expect([...f.memberIds]).not.toContain("D1");
    expect(out.layout.positions.has("D1")).toBe(false);
  });

  it("конец «в контейнер», раскрытый вложенно на корне, не плодит узел-дубль рядом с рамкой", async () => {
    // Корень: X (лист) и P (контейнер); P раскрыт → [A, C]; C раскрыт → [D];
    // ребро X→C ведёт В САМ контейнер C. На корне C — глубокий конец из реестра:
    // до фикса lift отдавал его гостем, projectGhosts материализовал листом-узлом —
    // на канве жили и рамка C, и узел C (duplicate id в RF ломал драг).
    const out = await computeViewLayout({
      nodes: [appNode("X"), { ...appNode("P"), parent_id: null, has_children: true, child_count: 2 } as AppNode],
      endpoints: [
        { ...ghost("C", [a("P")]), is_external: false, has_children: true, child_count: 1 },
      ],
      edges: [edge("eXC", "X", "C", "в контейнер")],
      containerId: null,
      viewLayout: { P: { x: 400, y: 0 }, X: { x: 0, y: 0 }, C: { x: 500, y: 100 } },
      ancestorIds: [],
      expanded: new Set(["P", "C"]),
      localChildren: {
        P: [
          { ...appNode("A"), parent_id: "P" } as AppNode,
          { ...appNode("C"), parent_id: "P", has_children: true, child_count: 1 } as AppNode,
        ],
        C: [{ ...appNode("D"), parent_id: "C" } as AppNode],
      },
      edgeQuality: "full", // авто-режим P10 без замеров скипнул бы роутер
    });
    // C отображается ТОЛЬКО рамкой: сущности-узла с его id нет
    expect(out.layout.entities.map((e) => e.id)).not.toContain("C");
    const frameIds = out.layout.guestFrames.map((f) => f.id).sort();
    expect(frameIds).toEqual(["C", "P"]);
    // связь «прямо в раскрытый контейнер» видна и упирается в границу его рамки —
    // ровно один конец, дубля-узла рядом с рамкой по-прежнему нет
    expect(out.layout.groupArr.map((g) => [g.id, g.source, g.target])).toEqual([["eXC", "X", "C"]]);
    const cf = out.layout.guestFrames.find((f) => f.id === "C")!;
    const route = out.layout.autoRoutes?.get("eXC");
    expect(onRectBorder(route![route!.length - 1], cf.rect)).toBe(true);
    expect(out.layout.nodes.map((n) => n.id).sort()).toEqual(["A", "D", "X"]);
  });

  it("собственная связь КОНТЕЙНЕРА УРОВНЯ видна изнутри и упирается в родную рамку", async () => {
    // Тот же кейс, что раскрытый контейнер, но увиденный ИЗНУТРИ: пользователь вошёл в P,
    // у которого есть своя связь с внешним G. Раньше конец «сам контейнер уровня»
    // дропался, и на схеме оставался висеть G без единой стрелки.
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAB", "A", "B", "зов"), edge("eGP", "G", "P", "снаружи в контейнер")],
      endpoints: [ghost("G", [])],
    }));
    expect(out.layout.groupArr.map((g) => [g.id, g.source, g.target]).sort())
      .toEqual([["eAB", "A", "B"], ["eGP", "G", "P"]]);
    // рамка уровня отдана наружу якорем и НЕ попала в guestFrames (её рисует оверлей)
    expect(out.layout.levelFrame?.id).toBe("P");
    expect(out.layout.levelFrame?.native).toBe(true);
    expect(out.layout.guestFrames.map((f) => f.id)).not.toContain("P");
    // стрелка кончается на границе рамки
    const route = out.layout.autoRoutes?.get("eGP");
    expect(onRectBorder(route![route!.length - 1], out.layout.levelFrame!.rect)).toBe(true);
  });

  it("ПУСТОЙ уровень: рамка контейнера есть всегда, размером как под один узел", async () => {
    // Пользователь вошёл в атомарный узел: детей нет. Раньше здесь был пустой холст.
    const out = await computeViewLayout(levelInput({
      nodes: [], edges: [], endpoints: [], viewLayout: {},
    }));
    expect(out.layout.nodes).toEqual([]);
    const lf = out.layout.levelFrame;
    expect(lf?.id).toBe("P");
    // рамка обнимает ровно один синтетический бокс: шире и выше узла, но не безразмерна
    expect(lf!.rect.w).toBeGreaterThan(NODE_W);
    expect(lf!.rect.w).toBeLessThan(NODE_W * 3);
    expect(lf!.rect.h).toBeGreaterThan(NODE_H);
    expect(lf!.rect.h).toBeLessThan(NODE_H * 3);
    // синтетический член — деталь расчёта рамок: узлом не становится и не засеивается
    expect(out.layout.entities).toEqual([]);
    expect(out.intents).toEqual([]);
  });

  it("ПУСТОЙ уровень: собственные связи контейнера упираются в его рамку, гости снаружи", async () => {
    // Ровно исходная жалоба: соседи бывшего атома висели без стрелок.
    const out = await computeViewLayout(levelInput({
      nodes: [],
      edges: [edge("eGP", "G", "P", "снаружи"), edge("ePH", "P", "H", "наружу")],
      endpoints: [ghost("G", []), ghost("H", [])],
      viewLayout: {},
    }));
    expect(out.layout.groupArr.map((g) => [g.id, g.source, g.target]).sort())
      .toEqual([["eGP", "G", "P"], ["ePH", "P", "H"]]);
    const lf = out.layout.levelFrame!;
    for (const id of ["eGP", "ePH"]) {
      const r = out.layout.autoRoutes?.get(id);
      expect(r?.length ?? 0).toBeGreaterThanOrEqual(2);
      const frameEnd = id === "eGP" ? r![r!.length - 1] : r![0];
      expect(onRectBorder(frameEnd, lf.rect)).toBe(true);
    }
    // гости не залезли внутрь рамки (keep-out видит её так же, как рисунок)
    for (const id of ["G", "H"]) {
      const p = out.layout.positions.get(id)!;
      const inside = p.x > lf.rect.x && p.x < lf.rect.x + lf.rect.w
        && p.y > lf.rect.y && p.y < lf.rect.y + lf.rect.h;
      expect(inside).toBe(false);
    }
  });

  it("на КОРНЕ рамки уровня нет — конец «в корень» невозможен, поведение прежнее", async () => {
    // containerId = null: frameIds пуст, ничего нового не появляется.
    const out = await computeViewLayout(levelInput({
      containerId: null,
      ancestorIds: [],
      edges: [edge("eAB", "A", "B", "зов")],
      endpoints: [],
    }));
    expect(out.layout.levelFrame).toBeUndefined();
    expect(out.layout.groupArr.map((g) => g.id)).toEqual(["eAB"]);
  });

  it("конец в раскрытый ГОСТЕВОЙ контейнер скрыт, пока его дети отображаются", async () => {
    // G — контейнер чужой ветки (под Q); его ребёнок Gc — тоже конец рёбер.
    // Q и G раскрыты: Gc отображается листом, G — рамкой вокруг него; конец e1
    // «прямо в G» не должен воскресить G узлом поверх рамки.
    const out = await computeViewLayout(levelInput({
      edges: [edge("e1", "A", "G", "в контейнер"), edge("e2", "B", "Gc", "в ребёнка")],
      endpoints: [
        { ...ghost("G", [a("Q")]), has_children: true, child_count: 1 },
        ghost("Gc", [a("Q"), a("G")]),
      ],
      expanded: new Set(["Q", "G"]),
    }));
    expect(out.layout.entities.map((e) => e.id).sort()).toEqual(["Gc"]);
    expect(out.layout.guestFrames.map((f) => f.id).sort()).toEqual(["G", "Q"]);
    expect(out.layout.groupArr.map((g) => g.id)).toEqual(["e2"]);
  });

  it("гость-контейнер, раскрытый «вхолостую» (без глубоких концов), остаётся узлом-концом", async () => {
    // Раскрытие гостя G ничего не обнажило (глубже него концов нет) — рамки нет,
    // и прятать его узел нельзя: связь A→G пропала бы без замены.
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAG", "A", "G", "в контейнер")],
      endpoints: [{ ...ghost("G", [a("Q")]), has_children: true, child_count: 1 }],
      expanded: new Set(["Q", "G"]),
    }));
    expect(out.layout.entities.map((e) => e.id)).toContain("G");
    expect(out.layout.groupArr.map((g) => g.id)).toEqual(["eAG"]);
  });

  it("инвариант наложений: два владеемых узла, сохранённых друг на друге, разведены и персистятся", async () => {
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAB", "A", "B", "зов")],
      endpoints: [],
      viewLayout: { A: { x: 0, y: 0 }, B: { x: 30, y: 10 } }, // наложены в БД
    }));
    const pa = out.layout.positions.get("A")!;
    const pb = out.layout.positions.get("B")!;
    const overlap = pa.x < pb.x + 180 && pa.x + 180 > pb.x && pa.y < pb.y + 70 && pa.y + 70 > pb.y;
    expect(overlap).toBe(false);
    // сдвинутые владеемые персистятся интентом — следующий прогон no-op
    const seeded = out.intents.filter((i) => i.kind === "seed-positions").flatMap((i) => i.seeds);
    expect(seeded.length).toBeGreaterThan(0);
    const seededLayout = Object.fromEntries(seeded.map((s) => [s.id, { x: s.x, y: s.y }]));
    const second = await computeViewLayout(levelInput({
      edges: [edge("eAB", "A", "B", "зов")],
      endpoints: [],
      viewLayout: { A: { x: 0, y: 0 }, B: { x: 30, y: 10 }, ...seededLayout },
    }));
    expect(second.intents).toEqual([]);
  });

  it("R5: дети раскрытого локала не догружены → контейнер остаётся свёрнутым узлом", async () => {
    const out = await computeViewLayout(levelInput({
      edges: [edge("eAB", "A", "B", "зов")],
      endpoints: [],
      expanded: new Set(["B"]),
      localChildren: {}, // фетч ещё в полёте
    }));
    expect(out.layout.nodes.map((n) => n.id).sort()).toEqual(["A", "B"]);
    expect(out.layout.guestFrames).toEqual([]);
  });
});

// ГАШЕНИЕ ОСЦИЛЛЯЦИЙ МАРШРУТОВ (2026-08-06): роутер не идемпотентен относительно
// prev (гистерезис осциллирует на реальных сценах — флип слотов/плашек), поэтому
// при ПОБИТОВО неизменных входах роутинга результат удерживается ЦЕЛИКОМ из prev.
describe("гашение осцилляций маршрутов (prevRouteSig)", () => {
  const sameRoutes = (a: LayoutResult, b: LayoutResult) =>
    [...a.autoRoutes!.entries()].every(([id, r]) => {
      const q = b.autoRoutes!.get(id);
      return q && q.length === r.length && q.every((p, i) => p.x === r[i].x && p.y === r[i].y);
    }) && a.autoRoutes!.size === b.autoRoutes!.size;

  it("идентичные входы + сигнатура prev → маршруты/хэндлы/плашки удерживаются из prev ЦЕЛИКОМ", async () => {
    const A = await computeViewLayout(levelInput());
    // доказательство механизма: подсовываем в prev МАРШРУТ С ИЗЛОМОМ, которого нет
    // в свежем расчёте — если гашение сработало, результат вернёт именно его
    const tampered = new Map(A.layout.autoRoutes!);
    const firstId = [...tampered.keys()][0];
    const orig = tampered.get(firstId)!;
    const mid = { x: (orig[0].x + orig[orig.length - 1].x) / 2, y: -999 };
    tampered.set(firstId, [orig[0], mid, orig[orig.length - 1]]);
    const B = await computeViewLayout(levelInput({
      prevRoutes: tampered,
      prevEdgeHandles: A.layout.edgeHandles,
      prevRouteSig: A.routeSig,
      prevLabelPlacements: A.layout.labelPlacements,
    }));
    expect([...B.layout.autoRoutes!.get(firstId)!].map((p) => p.y)).toContain(-999);
    expect(B.layout.edgeHandles).toEqual(A.layout.edgeHandles);
    expect(B.layout.labelPlacements).toEqual(A.layout.labelPlacements);
  });

  it("фикспойнт: прогон с prev=свой же результат идентичен ему (нет флипа)", async () => {
    const A = await computeViewLayout(levelInput());
    const B = await computeViewLayout(levelInput({
      prevRoutes: A.layout.autoRoutes,
      prevEdgeHandles: A.layout.edgeHandles,
      prevRouteSig: A.routeSig,
      prevLabelPlacements: A.layout.labelPlacements,
    }));
    expect(sameRoutes(A.layout, B.layout)).toBe(true);
    expect(B.layout.edgeHandles).toEqual(A.layout.edgeHandles);
    expect(B.layout.labelPlacements).toEqual(A.layout.labelPlacements);
  });

  it("сдвиг узла меняет сигнатуру → гашение не применяется, роутинг полный", async () => {
    const A = await computeViewLayout(levelInput());
    const moved = levelInput();
    moved.viewLayout = { A: { x: 0, y: 0 }, B: { x: 900, y: 400 } };
    const B = await computeViewLayout({
      ...moved,
      prevRoutes: A.layout.autoRoutes,
      prevEdgeHandles: A.layout.edgeHandles,
      prevRouteSig: A.routeSig,
      prevLabelPlacements: A.layout.labelPlacements,
    });
    expect(B.routeSig).not.toBe(A.routeSig);
    expect(sameRoutes(A.layout, B.layout)).toBe(false);
  });

  it("buildRouteSig: детерминирована и чувствительна к подписи ребра", () => {
    const ids = ["A", "B"];
    const pos = new Map([["A", { x: 0, y: 0 }], ["B", { x: 400, y: 0 }]]);
    const sizes = new Map<string, { w: number; h: number }>();
    const mk = (label: string) => [{
      id: "e1", source: "A", target: "B",
      members: [{ label, technology: null } as unknown as AppEdge],
    }];
    const s1 = buildRouteSig(ids, pos, sizes, mk("зов") as never, new Set(["e1"]), []);
    const s2 = buildRouteSig(ids, pos, sizes, mk("зов") as never, new Set(["e1"]), []);
    const s3 = buildRouteSig(ids, pos, sizes, mk("событие") as never, new Set(["e1"]), []);
    expect(s1).toBe(s2);
    expect(s1).not.toBe(s3);
  });
});

describe("edgeQuality: фолбэк-прогон без стадий качества стрелок (перф-эпик Ф3, P10)", () => {
  it("авто: незамеренная сцена → skip; все замерены → full; единичный незамеренный не роняет качество", async () => {
    // 4 отображаемых (A, B, гость G, контейнер D), замеров нет → пропуск
    const bare = await computeViewLayout({ ...levelInput(), edgeQuality: undefined });
    expect(bare.layout.autoRoutes).toBeUndefined();
    // все замерены → полный прогон
    const sz = { w: NODE_W, h: NODE_H };
    const all = await computeViewLayout({
      ...levelInput(), edgeQuality: undefined, sizes: { A: sz, B: sz, G: sz, D: sz },
    });
    expect(all.layout.autoRoutes).toBeDefined();
    // один незамеренный (создание узла из палитры) — качество не роняем
    const one = await computeViewLayout({
      ...levelInput(), edgeQuality: undefined, sizes: { A: sz, B: sz, G: sz },
    });
    expect(one.layout.autoRoutes).toBeDefined();
  });

  it("skip: позиции и интенты как у полного прогона, маршрутов/плашек нет", async () => {
    const full = await computeViewLayout(levelInput());
    const skip = await computeViewLayout({ ...levelInput(), edgeQuality: "skip" });
    expect(full.layout.autoRoutes).toBeDefined();
    expect(skip.layout.autoRoutes).toBeUndefined();
    expect(skip.layout.labelPlacements).toBeUndefined();
    // раскладка узлов, рамки и засев владения НЕ зависят от пропуска
    expect([...skip.layout.positions.entries()]).toEqual([...full.layout.positions.entries()]);
    expect(skip.intents).toEqual(full.intents);
    expect(skip.layout.guestFrames).toEqual(full.layout.guestFrames);
  });
});
