import { describe, it, expect } from "vitest";
import { computeViewLayout, type PipelineInput } from "../graph/layout/pipeline";
import { parentFrameOf } from "../graph/layout/frames";
import { NODE_W, NODE_H } from "../graph/constants";
import type { Node as AppNode, Edge as AppEdge } from "../../types";

// СПАЙК Ф1 эпика «схема развёртывания» (docs/tasks/deployment-view.md §6, вариант А):
// площадки — ЛОКАЛЬНЫЕ раскрытые контейнеры уровня (R5, localChildren), экземпляр —
// обычный блок с id `deploy:<узел>@<площадка>` внутри рамки своей площадки. Вопрос
// спайка: держит ли конвейер без правок ядра (1) три уровня вложенных площадок,
// (2) экземпляр одного объекта в двух ветках, (3) связи между экземплярами.
//
// Единственная правка ядра, которую спайк подменял моком, — предел инлайн-вложенности
// MAX_INLINE_DEPTH = 2 (container.md C8): с ним третий уровень площадок остаётся
// свёрнутой карточкой (сторож — pipeline.test «R5-предел (C8)»). С Ф2 предел — вход
// конвейера maxInlineDepth; холст развёртывания передаёт Infinity, как здесь.

function block(id: string, parent_id: string | null, kids = 0): AppNode {
  return {
    id, name: id, description: null, role: null, technology: null,
    parent_id, shape: "service", is_external: false, status: "existing",
    openapi_spec: null, docs: [], version: 1,
    created_at: "", updated_at: "", has_children: kids > 0, child_count: kids,
    approval: "in_progress", approval_effective: "in_progress", sites: [],
  } as AppNode;
}
function edge(id: string, source_id: string, target_id: string, label: string | null = null): AppEdge {
  return { id, label, technology: null, source_id, target_id, created_at: "2026-10-22T00:00:00Z" } as AppEdge;
}

const S1 = "deploy:site:S1", S2 = "deploy:site:S2", S3 = "deploy:site:S3", T = "deploy:site:T";
const A_S3 = "deploy:A@S3", B_S2 = "deploy:B@S2", C_S1 = "deploy:C@S1", A_T = "deploy:A@T";

// Сцена: корневые площадки S1 ⊃ S2 ⊃ S3 и T; объект A размещён в двух ветках (S3 и T),
// B — в S2, C — в S1; U — объект без размещения (голый локал уровня). Связи — по правилу
// ближайших экземпляров (D11): A@S3→B@S2 (та же корневая площадка), A@T→B@S2
// (единственный экземпляр цели), B@S2→C@S1.
function scene(viewLayout: PipelineInput["viewLayout"] = {}): PipelineInput {
  return {
    nodes: [block(S1, null, 2), block(T, null, 1), block("U", null)],
    endpoints: [],
    edges: [edge("eAB1", A_S3, B_S2, "заказ"), edge("eAB2", A_T, B_S2, "заказ"), edge("eBC", B_S2, C_S1)],
    containerId: null,
    viewLayout,
    ancestorIds: [],
    expanded: new Set([S1, S2, S3, T]),
    localChildren: {
      [S1]: [block(S2, S1, 2), block(C_S1, S1)],
      [S2]: [block(S3, S2, 1), block(B_S2, S2)],
      [S3]: [block(A_S3, S3)],
      [T]: [block(A_T, T)],
    },
    maxInlineDepth: Infinity,
    edgeQuality: "full",
  };
}

type Rect = { x: number; y: number; w: number; h: number };
const inside = (p: { x: number; y: number }, r: Rect): boolean =>
  p.x >= r.x && p.y >= r.y && p.x + NODE_W <= r.x + r.w && p.y + NODE_H <= r.y + r.h;
const rectInside = (a: Rect, b: Rect): boolean =>
  a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

describe("спайк развёртывания — площадки как раскрытые локалы (вариант А)", () => {
  it("три уровня площадок — три вложенные рамки, экземпляры внутри своих, A в двух ветках", async () => {
    const out = await computeViewLayout(scene());
    const frames = out.layout.guestFrames;
    expect(frames.map((f) => f.id).sort()).toEqual([S1, S2, S3, T].sort());
    const f = (id: string) => frames.find((x) => x.id === id)!;
    // вложенность по членству и по геометрии
    expect(parentFrameOf(frames, f(S3))?.id).toBe(S2);
    expect(parentFrameOf(frames, f(S2))?.id).toBe(S1);
    expect(parentFrameOf(frames, f(S1))).toBeNull();
    expect(parentFrameOf(frames, f(T))).toBeNull();
    expect(rectInside(f(S3).rect, f(S2).rect)).toBe(true);
    expect(rectInside(f(S2).rect, f(S1).rect)).toBe(true);
    // порядок guestFrames — внешние первыми (родитель раньше ребёнка для parentId RF)
    const order = frames.map((x) => x.id);
    expect(order.indexOf(S1)).toBeLessThan(order.indexOf(S2));
    expect(order.indexOf(S2)).toBeLessThan(order.indexOf(S3));
    // экземпляры — отображаемые локалы; площадки поглощены раскрытием (их нет среди узлов)
    expect(out.layout.nodes.map((n) => n.id).sort()).toEqual([A_S3, A_T, B_S2, C_S1, "U"].sort());
    const pos = (id: string) => out.layout.positions.get(id)!;
    expect(inside(pos(A_S3), f(S3).rect)).toBe(true);
    expect(inside(pos(B_S2), f(S2).rect)).toBe(true);
    expect(inside(pos(C_S1), f(S1).rect)).toBe(true);
    expect(inside(pos(A_T), f(T).rect)).toBe(true);
    // экземпляр в другой ветке — отдельный блок, вне чужой корневой площадки
    expect(inside(pos(A_T), f(S1).rect)).toBe(false);
    expect(pos(A_S3)).not.toEqual(pos(A_T));
    // объект без размещения — вне всех рамок
    for (const fr of frames) expect(inside(pos("U"), fr.rect)).toBe(false);
    // связи между экземплярами: три группы с концами-экземплярами, у каждой авто-маршрут
    expect(out.layout.groupArr.map((g) => `${g.source}>${g.target}`).sort())
      .toEqual([`${A_S3}>${B_S2}`, `${A_T}>${B_S2}`, `${B_S2}>${C_S1}`].sort());
    for (const g of out.layout.groupArr) expect(out.layout.autoRoutes?.get(g.id)?.length ?? 0).toBeGreaterThan(1);
  });

  it("повторный прогон на засеянных позициях — фикспойнт (персист/undo достаются бесплатно)", async () => {
    const first = await computeViewLayout(scene());
    const seeded: PipelineInput["viewLayout"] = {};
    for (const [id, p] of first.layout.positions) seeded[id] = { x: p.x, y: p.y };
    const second = await computeViewLayout(scene(seeded));
    for (const [id, p] of first.layout.positions) expect(second.layout.positions.get(id)).toEqual(p);
    expect(second.layout.guestFrames.map((x) => x.rect)).toEqual(first.layout.guestFrames.map((x) => x.rect));
  });
});
