// Черновики импорта процессов: название из шапки диаграммы, заголовка Markdown или имени
// файла; Markdown с несколькими блоками; текст в запрос уходит без шапки.
import { describe, expect, it } from "vitest";
import { autoName, fileStem, splitDiagram, splitFile } from "../processes/importDrafts";

const SEQ = "sequenceDiagram\n    participant A as Покупатель\n    A->>B: создать заказ";

describe("splitDiagram: название и текст без шапки", () => {
  it("шапка ---title--- перед диаграммой: название из неё, в тексте шапки нет", () => {
    const r = splitDiagram(`---\ntitle: Оплата заказа\n---\n${SEQ}`);
    expect(r.title).toBe("Оплата заказа");
    expect(r.body).toBe(SEQ);
  });

  it("кавычки вокруг названия в шапке снимаются, прочие ключи шапки уходят вместе с ней", () => {
    const r = splitDiagram(`\n---\nconfig:\n  theme: forest\ntitle: "Возврат"\n---\n${SEQ}`);
    expect(r.title).toBe("Возврат");
    expect(r.body).toBe(SEQ);
  });

  it("строка title внутри диаграммы: название из неё, сама строка из текста убрана", () => {
    const r = splitDiagram("sequenceDiagram\n    title Исполнение заказа\n    A->>B: x");
    expect(r.title).toBe("Исполнение заказа");
    expect(r.body).toBe("sequenceDiagram\n    A->>B: x");
  });

  it("title с двоеточием тоже понимается", () => {
    expect(splitDiagram("sequenceDiagram\ntitle: Доставка\nA->>B: x").title).toBe("Доставка");
  });

  it("шаг участника с именем title не принимается за название", () => {
    const text = "sequenceDiagram\ntitle->>B: x";
    expect(splitDiagram(text)).toEqual({ title: null, body: text });
  });

  it("без названия текст остаётся как был", () => {
    expect(splitDiagram(SEQ)).toEqual({ title: null, body: SEQ });
  });

  it("незакрытая черта — не шапка: текст не теряется", () => {
    const text = `---\n${SEQ}`;
    expect(splitDiagram(text).body).toBe(text);
  });
});

describe("splitFile: черновики файла", () => {
  it(".mmd — один черновик, запасное название из имени файла без расширения", () => {
    const [d, ...rest] = splitFile("Оплата заказа.mmd", SEQ);
    expect(rest).toHaveLength(0);
    expect(d).toEqual({ raw: SEQ, fallbackName: "Оплата заказа" });
    expect(autoName(d)).toBe("Оплата заказа");
  });

  it("название из title важнее имени файла", () => {
    const [d] = splitFile("draft-1.mmd", `---\ntitle: Оформление заказа\n---\n${SEQ}`);
    expect(autoName(d)).toBe("Оформление заказа");
  });

  it(".md: название из ближайшего заголовка над блоком", () => {
    const md = ["# Процессы магазина", "", "## Оплата заказа", "", "Текст.", "",
      "```mermaid", SEQ, "```"].join("\n");
    const [d] = splitFile("процессы.md", md);
    expect(autoName(d)).toBe("Оплата заказа");
    expect(d.raw).toBe(SEQ);
  });

  it(".md с двумя блоками — два черновика, у каждого свой заголовок", () => {
    const md = ["## Оформление заказа", "```mermaid", SEQ, "```", "",
      "## Возврат", "```mermaid", "sequenceDiagram", "A->>B: вернуть", "```"].join("\n");
    const drafts = splitFile("flows.md", md);
    expect(drafts.map(autoName)).toEqual(["Оформление заказа", "Возврат"]);
    expect(drafts[1].raw).toBe("sequenceDiagram\nA->>B: вернуть");
  });

  it(".md: блоки без sequenceDiagram и не mermaid пропускаются, заголовок в коде не заголовок", () => {
    const md = ["## Схема", "```mermaid", "flowchart LR", "A-->B", "```",
      "```bash", "# не заголовок", "```", "```mermaid", SEQ, "```"].join("\n");
    const drafts = splitFile("x.md", md);
    expect(drafts).toHaveLength(1);
    expect(autoName(drafts[0])).toBe("Схема");
  });

  it(".md без заголовков: имя файла, второй блок с номером", () => {
    const md = ["```mermaid", SEQ, "```", "```mermaid", SEQ, "```"].join("\n");
    expect(splitFile("Ярмарка.md", md).map(autoName)).toEqual(["Ярмарка", "Ярмарка 2"]);
  });

  it(".md без диаграмм — пустой список", () => {
    expect(splitFile("readme.md", "# Заголовок\nтекст")).toEqual([]);
  });

  it("fileStem: без расширения и без пути", () => {
    expect(fileStem("a/b/Оплата.заказа.mmd")).toBe("Оплата.заказа");
    expect(fileStem("README")).toBe("README");
  });
});
