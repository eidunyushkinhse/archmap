// replaceLogicKind — правка вида схемы в YAML-тексте манифеста archmap-docs
// (режим BYOA «по одной схеме»): замена/вставка ключа kind строго в пределах
// блока схемы, без захода в mermaid-текст и соседние схемы/узлы.
import { describe, expect, it } from "vitest";
import { replaceLogicKind } from "../docsImport/manifestKind";

const MANIFEST = `docs:
  - node: billing
    logic:
      - name: OrderCreatedHandler
        kind: worker
        mermaid: |
          flowchart TD
            A[Start] --> B[Finish]
`;

describe("replaceLogicKind", () => {
  it("заменяет kind в блоке схемы (dash и name на одной строке)", () => {
    expect(replaceLogicKind(MANIFEST, "OrderCreatedHandler", "operation")).toBe(
      MANIFEST.replace("kind: worker", "kind: operation"),
    );
  });

  it("не найденное имя — null (фолбэк: манифест как есть)", () => {
    expect(replaceLogicKind(MANIFEST, "NoSuchWorker", "worker")).toBeNull();
  });

  it("не трогает kind внутри mermaid-текста (строки глубже ключей элемента)", () => {
    const src = `docs:
  - node: billing
    logic:
      - name: H
        kind: overview
        mermaid: |
          flowchart TD
            A[kind: worker]
            kind: worker
`;
    expect(replaceLogicKind(src, "H", "worker")).toBe(src.replace("kind: overview", "kind: worker"));
  });

  it("правит только запрошенную схему из нескольких (граница — следующее name)", () => {
    const src = `docs:
  - node: billing
    logic:
      - name: A
        kind: overview
        mermaid: |
          flowchart TD
      - name: B
        kind: worker
        mermaid: |
          flowchart LR
`;
    const got = replaceLogicKind(src, "A", "operation");
    expect(got).not.toBeNull();
    expect(got).toContain("name: A\n        kind: operation");
    expect(got).toContain("name: B\n        kind: worker");
  });

  it("вставляет kind, если ключа нет (бэк трактует отсутствие как overview)", () => {
    const src = `docs:
  - node: billing
    logic:
      - name: A
        mermaid: |
          flowchart TD
`;
    expect(replaceLogicKind(src, "A", "worker")).toBe(
      src.replace("      - name: A\n", "      - name: A\n        kind: worker\n"),
    );
  });

  it("граница блока — дедент на openapi (kind не ищется за пределами схемы)", () => {
    const src = `docs:
  - node: billing
    logic:
      - name: A
        mermaid: |
          flowchart TD
    openapi:
      file: api.yaml
`;
    expect(replaceLogicKind(src, "A", "worker")).toBe(
      src.replace("      - name: A\n", "      - name: A\n        kind: worker\n"),
    );
  });

  it("имя в кавычках совпадает с голым значением", () => {
    const src = `docs:
  - node: billing
    logic:
      - name: "POST /orders"
        kind: overview
        mermaid: |
          flowchart TD
`;
    expect(replaceLogicKind(src, "POST /orders", "operation")).toBe(
      src.replace("kind: overview", "kind: operation"),
    );
  });

  it("пустые строки внутри mermaid-скаляра не обрывают блок", () => {
    const src = `docs:
  - node: billing
    logic:
      - name: A
        mermaid: |
          flowchart TD

            A --> B
      - name: B
        kind: worker
        mermaid: |
          flowchart LR
`;
    expect(replaceLogicKind(src, "A", "worker")).toBe(
      src.replace("      - name: A\n", "      - name: A\n        kind: worker\n"),
    );
  });
});
