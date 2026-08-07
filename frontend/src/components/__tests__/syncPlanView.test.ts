// Тесты раскладки плана синхронизации (docsImport/syncPlanView.ts, Фаза 3).
// Проверяют то, что решает читаемость превью: неизменное не показывается,
// пропажи выделены отдельно, у изменений видно ЧТО меняется и ЧЕМ опознан узел,
// а итог применения не умалчивает о пропущенных действиях.
import { describe, it, expect } from "vitest";
import type { SyncApplyOut, SyncPreviewOut } from "../../types";
import { applySummary, planSections, planSummary } from "../docsImport/syncPlanView";

function preview(over: Partial<SyncPreviewOut> = {}): SyncPreviewOut {
  return {
    ok: true,
    errors: [],
    files: 1,
    nodes: [],
    edges: [],
    conflicts: [],
    warnings: [],
    summary: {},
    is_noop: false,
    graph_rev: 7,
    ...over,
  } as SyncPreviewOut;
}

describe("planSections", () => {
  it("неизменное не показывает, изменения раскладывает по разделам", () => {
    const p = preview({
      nodes: [
        { path: "С / new", action: "create", fields: [] },
        { path: "С / old", action: "unchanged", fields: [], matched_by: "source" },
        { path: "С / упавший", action: "missing", fields: [] },
      ],
      edges: [
        { source_path: "С / a", target_path: "С / b", action: "create" },
        { source_path: "С / c", target_path: "С / d", action: "unchanged" },
      ],
    });

    const keys = planSections(p).map((s) => s.key);
    expect(keys).toEqual(["nodes_create", "edges_create", "nodes_missing"]);
    // Пустые разделы отсутствуют целиком, unchanged не попадает никуда.
    expect(planSections(p).every((s) => s.rows.length > 0)).toBe(true);
  });

  it("пропажи помечены как требующие внимания", () => {
    const p = preview({ nodes: [{ path: "С / x", action: "missing", fields: [] }] });
    expect(planSections(p)[0].attention).toBe(true);
  });

  it("у изменённого узла видно, какие поля меняются и чем он опознан", () => {
    const p = preview({
      nodes: [
        { path: "С / svc", action: "update", fields: ["name", "source_ref"], matched_by: "source" },
      ],
    });
    expect(planSections(p)[0].rows[0].note).toBe("имя, источник · по источнику");
  });

  it("матч по имени показан даже без изменений полей — он слабее якорного", () => {
    const p = preview({ nodes: [{ path: "С / svc", action: "update", fields: [], matched_by: "name" }] });
    expect(planSections(p)[0].rows[0].note).toBe("по имени");
  });
});

describe("planSummary", () => {
  it("пустой план называет вещи своими именами", () => {
    expect(planSummary(preview({ is_noop: true }))).toContain("применять нечего");
  });

  it("считает изменения и отдельно неизменное", () => {
    const s = planSummary(
      preview({
        summary: { nodes_create: 2, nodes_missing: 1, edges_create: 3, nodes_unchanged: 10 },
      }),
    );
    expect(s).toBe("2 новых, 1 пропавших, 3 новых связей · без изменений 10");
  });

  it("для неразобранного входа сводки нет", () => {
    expect(planSummary(preview({ ok: false, errors: ["битый YAML"] }))).toBe("");
  });
});

describe("applySummary", () => {
  function applied(over: Partial<SyncApplyOut> = {}): SyncApplyOut {
    return {
      created_nodes: [],
      updated_nodes: [],
      deprecated_nodes: [],
      created_edges: [],
      skipped: [],
      graph_rev: 8,
      ...over,
    } as SyncApplyOut;
  }

  it("перечисляет сделанное", () => {
    const s = applySummary(applied({ created_nodes: ["a"], updated_nodes: ["b", "c"] }));
    expect(s).toBe("Схема обновлена: 1 создано, 2 обновлено");
  });

  it("не умалчивает о пропущенных действиях", () => {
    // Цель действия могла исчезнуть между расчётом и записью — сказать «применено
    // всё» значило бы соврать.
    const s = applySummary(applied({ created_nodes: ["a"], skipped: ["x: узел исчез"] }));
    expect(s).toContain("Пропущено: 1");
  });

  it("пустое применение не притворяется работой", () => {
    expect(applySummary(applied())).toBe("Схема уже актуальна");
  });
});
