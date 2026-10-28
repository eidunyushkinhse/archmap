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
        { returned: false, path: "С / new", action: "create", fields: [] },
        { returned: false, path: "С / old", action: "unchanged", fields: [], matched_by: "code" },
        { returned: false, path: "С / упавший", action: "missing", fields: [] },
      ],
      edges: [
        { source_path: "С / a", target_path: "С / b", action: "create", fields: [] },
        { source_path: "С / c", target_path: "С / d", action: "unchanged", fields: [] },
      ],
    });

    const keys = planSections(p).map((s) => s.key);
    expect(keys).toEqual(["nodes_create", "edges_create", "nodes_missing"]);
    // Пустые разделы отсутствуют целиком, unchanged не попадает никуда.
    expect(planSections(p).every((s) => s.rows.length > 0)).toBe(true);
  });

  it("пропажи помечены как требующие внимания", () => {
    const p = preview({ nodes: [{ returned: false, path: "С / x", action: "missing", fields: [] }] });
    expect(planSections(p)[0].attention).toBe(true);
  });

  it("у изменённого узла видно, какие поля меняются и чем он опознан", () => {
    const p = preview({
      nodes: [
        { returned: false, path: "С / svc", action: "update", fields: ["name", "source_ref"], matched_by: "code" },
      ],
    });
    expect(planSections(p)[0].rows[0].note).toBe("имя, источник · нашли по коду");
  });

  it("матч по имени показан даже без изменений полей — он слабее якорного", () => {
    const p = preview({ nodes: [{ returned: false, path: "С / svc", action: "update", fields: [], matched_by: "name" }] });
    // Имя решает только ВНУТРИ контейнера — фраза называет, внутри какого.
    expect(planSections(p)[0].rows[0].note).toBe("нашли по имени внутри «С»");
  });

  it("матч по имени зависимости назван своим словом", () => {
    const p = preview({
      nodes: [{ returned: false, path: "С / db", action: "update", fields: [], matched_by: "dependency" }],
    });
    expect(planSections(p)[0].rows[0].note).toBe("нашли по имени зависимости");
  });

  it("у объекта верхнего уровня имя решает не внутри контейнера, а на верхнем уровне", () => {
    const p = preview({
      nodes: [{ returned: false, path: "Система", action: "update", fields: [], matched_by: "name" }],
    });
    expect(planSections(p)[0].rows[0].note).toBe("нашли по имени на верхнем уровне");
  });

  it("у новых объектов сказано, будет ли источник и какой", () => {
    const p = preview({
      nodes: [
        { returned: false, path: "С / a", action: "create", fields: [],
          source: { repo: "github.com/org/a", path: "src/api" } },
        { returned: false, path: "С / b", action: "create", fields: [], source: { host: "postgres" } },
        { returned: false, path: "С / c", action: "create", fields: [] },
      ],
    });
    expect(planSections(p)[0].rows.map((r) => r.note)).toEqual([
      "источник: код github.com/org/a, путь src/api",
      "источник: имя зависимости postgres",
      "источника нет — будет опознаваться по имени",
    ]);
  });
});

describe("связи", () => {
  it("у новой связи назван канал, у обновляемой — чем заполнится пустое", () => {
    const p = preview({
      edges: [
        { source_path: "С / producer", target_path: "С / bus", action: "create", fields: [], channel: "topic.c", is_synchronous: null },
        { source_path: "С / producer", target_path: "С / bus", action: "update", fields: ["channel"], channel: "topic.a", is_synchronous: null },
        { source_path: "С / bus", target_path: "С / consumer", action: "update", fields: ["channel", "is_synchronous"], channel: "topic.a", is_synchronous: false },
        { source_path: "С / a", target_path: "С / b", action: "create", fields: [], channel: null, is_synchronous: null },
      ],
    });
    const sections = planSections(p);
    expect(sections.map((s) => s.key)).toEqual(["edges_create", "edges_update"]);
    expect(sections[0].rows.map((r) => r.note)).toEqual(["канал topic.c", ""]);
    expect(sections[1].rows.map((r) => r.note)).toEqual(["канал ← topic.a", "канал ← topic.a, тип ← асинхронный"]);
  });

  it("сводка и итог считают дополненные связи", () => {
    expect(planSummary(preview({ summary: { edges_update: 2, edges_unchanged: 1 } }))).toBe(
      "2 изменённых связей · без изменений 1",
    );
    const r: SyncApplyOut = {
      created_nodes: [], updated_nodes: [], deprecated_nodes: [], created_edges: [],
      updated_edges: ["С / producer → С / bus"], skipped: [], graph_rev: 3,
    };
    expect(applySummary(r)).toBe("Схема обновлена: 1 связей дополнено");
  });
});

describe("planSummary", () => {
  it("пустой план называет вещи своими именами", () => {
    expect(planSummary(preview({ is_noop: true }))).toBe(
      "Применять нечего. Схема уже соответствует YAML",
    );
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

describe("вернувшиеся объекты", () => {
  // Раньше такой узел не попадал в план ни строкой: он был unchanged, а
  // неизменные скрыты (находка проверки-2 №1).
  it("показаны отдельным разделом даже когда статус не трогаем", () => {
    const p = preview({
      nodes: [{ returned: true, path: "С / seed", action: "unchanged", fields: [] }],
    });

    const [section] = planSections(p);
    expect(section.key).toBe("nodes_returned");
    expect(section.rows[0].note).toBe("статус оставляем как есть");
  });

  it("с включённой галочкой сказано, что вернём в строй", () => {
    const p = preview({
      nodes: [{ returned: true, path: "С / seed", action: "update", fields: ["status"] }],
    });

    const [section] = planSections(p);
    expect(section.key).toBe("nodes_returned");
    expect(section.rows[0].note).toBe("вернётся в строй");
  });

  it("вернувшийся не дублируется в «Изменённых»", () => {
    const p = preview({
      nodes: [
        { returned: true, path: "С / seed", action: "update", fields: ["status"] },
        { returned: false, path: "С / other", action: "update", fields: ["role"] },
      ],
    });

    const update = planSections(p).find((s) => s.key === "nodes_update");
    expect(update?.rows.map((r) => r.path)).toEqual(["С / other"]);
  });
});
