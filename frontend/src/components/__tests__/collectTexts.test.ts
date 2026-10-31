// Слова окна «Собрать с компонентов» (решения владельца 2026-10-31): строки-факты по
// правилу приоритета контейнера, тексты вопросов краевых случаев на языке разбора
// ввоза и итог сбора. Чистые функции — без окна.
import { describe, it, expect } from "vitest";
import {
  asksSpec, candidateSub, collectFacts, collectLine, collectResult, paramQuestion, specQuestion,
} from "../element/collectTexts";
import type { CollectFactsOut, CollectFactsPreview } from "../../types";

function preview(over: Partial<CollectFactsPreview> = {}): CollectFactsPreview {
  return {
    components: [], param_clashes: [], specs: [], container_has_spec: false, single_spec_from: null, ...over,
  };
}

const result = (over: Partial<CollectFactsOut> = {}): CollectFactsOut => ({
  moved_params: 0, spec_moved: false, dropped_params: 0, dropped_specs: 0, left_params: [], left_specs: 0, ...over,
});

describe("строки окна сбора", () => {
  it("строка компонента", () => {
    expect(collectLine({ node_id: "a", name: "api", params: 2, has_spec: true })).toBe("api · 2 параметра, спецификация");
    expect(collectLine({ node_id: "s", name: "scheduler", params: 1, has_spec: false })).toBe("scheduler · 1 параметр");
    expect(collectLine({ node_id: "c", name: "checkout", params: 0, has_spec: true })).toBe("checkout · спецификация");
  });

  it("факты: параметр контейнера, своя спецификация контейнера, единственный держатель", () => {
    const keeps = (names: string[]) => ({
      name: "DATABASE_URL", container_keeps: true,
      candidates: [
        { node_id: "orders", node_name: "orders", description: "адрес базы" },
        ...names.map((n) => ({ node_id: n, node_name: n, description: null })),
      ],
    });
    expect(collectFacts(preview({
      param_clashes: [keeps(["api"])],
      specs: [{ node_id: "orders", name: "orders" }, { node_id: "api", name: "api" }],
      container_has_spec: true,
    }), "orders")).toEqual([
      "Параметр «DATABASE_URL» есть у контейнера — остаётся его описание, у компонента «api» параметр будет отброшен",
      "У контейнера есть своя спецификация — спецификация компонента «api» будет отброшена",
    ]);
    expect(collectFacts(preview({
      param_clashes: [keeps(["api", "outbox"])],
      specs: [{ node_id: "orders", name: "orders" }, { node_id: "api", name: "api" }, { node_id: "outbox", name: "outbox" }],
      container_has_spec: true,
    }), "orders")).toEqual([
      "Параметр «DATABASE_URL» есть у контейнера — остаётся его описание, у компонентов «api» и «outbox» параметр будет отброшен",
      "У контейнера есть своя спецификация — спецификации компонентов «api» и «outbox» будут отброшены",
    ]);
    const single = preview({ specs: [{ node_id: "api", name: "api" }], single_spec_from: "api" });
    expect(collectFacts(single, "orders")).toEqual(["Спецификация компонента «api» переедет контейнеру"]);
    expect(asksSpec(single, "orders")).toBe(false);
    // Своя спецификация без держателей у компонентов — сказать нечего.
    expect(collectFacts(preview({ specs: [{ node_id: "orders", name: "orders" }], container_has_spec: true }), "orders"))
      .toEqual([]);
  });

  it("вопрос о параметре: «по-разному» — только когда описания расходятся", () => {
    const clash = (a: string | null, b: string | null, extra: string[] = []) => ({
      name: "DATABASE_URL", container_keeps: false,
      candidates: [
        { node_id: "api", node_name: "api", description: a },
        { node_id: "outbox", node_name: "outbox", description: b },
        ...extra.map((n) => ({ node_id: n, node_name: n, description: null })),
      ],
    });
    expect(paramQuestion(clash("адрес", "другой адрес"), "orders")).toEqual({
      title: "Параметр «DATABASE_URL» описан у компонентов «api» и «outbox» по-разному. Чьё описание считаем верным?",
      why: "У контейнера «orders» этого параметра нет, поэтому приоритета нет: ArchMap оставит одну запись у "
        + "контейнера, вторая будет отброшена.",
      ifLeft: "Если не отвечать, то параметр останется у компонентов, рекомендация тоже останется.",
    });
    expect(paramQuestion(clash("адрес", "адрес"), "orders").title)
      .toBe("Параметр «DATABASE_URL» описан у компонентов «api» и «outbox». Чьё описание считаем верным?");
    expect(paramQuestion(clash(null, null, ["worker"]), "orders").why).toMatch(/остальные будут отброшены\.$/);
    expect(candidateSub(" адрес ")).toBe("«адрес»");
    expect(candidateSub(null)).toBe("без описания");
  });

  it("вопрос о спецификации нескольких держателей", () => {
    const p = preview({ specs: [{ node_id: "api", name: "api" }, { node_id: "outbox", name: "outbox" }] });
    expect(asksSpec(p, "orders")).toBe(true);
    expect(asksSpec({ ...p, container_has_spec: true }, "orders")).toBe(false);
    expect(specQuestion(["api", "outbox"], "orders")).toEqual({
      title: "Спецификация есть у компонентов «api» и «outbox». Чью считаем спецификацией контейнера «orders»?",
      why: "У контейнера своей спецификации нет, а у компонента её быть не может: спецификация описывает API "
        + "контейнера целиком. ArchMap перенесёт выбранную, вторая будет отброшена.",
      ifLeft: "Если не отвечать, то спецификации останутся у компонентов, рекомендация тоже останется.",
    });
  });

  it("итог: собрано, отброшено, осталось у компонентов", () => {
    expect(collectResult(result({
      moved_params: 3, spec_moved: true, dropped_params: 1, dropped_specs: 2, left_params: ["RETRY_TIMEOUT"],
    }))).toEqual([
      "Собрано: 3 параметра, спецификация.",
      "Отброшено: 1 параметр, 2 спецификации.",
      "Осталось у компонентов: параметр «RETRY_TIMEOUT».",
    ]);
    expect(collectResult(result({ left_params: ["A", "B"], left_specs: 2 }))).toEqual([
      "Ничего не собрано.",
      "Осталось у компонентов: параметры «A» и «B», 2 спецификации.",
    ]);
    expect(collectResult(result({ left_params: ["A", "B", "C", "D", "E", "F", "G"] }))[1])
      .toBe("Осталось у компонентов: параметры «A», «B», «C», «D», «E» и ещё 2.");
  });
});
