// Генератор ER-диаграммы из записей структуры БД.
//
// Диаграмма ПРОИЗВОДНА от таблиц/колонок, поэтому проверяется чистая функция, а не
// картинка. Последний тест гоняет вывод НАСТОЯЩИМ парсером mermaid: границы синтаксиса
// erDiagram (обязательный тип атрибута, пробелы, кавычки) выяснены пробами, и без
// парсера в тесте они разъедутся при первом же обновлении библиотеки.
import { describe, expect, it } from "vitest";
import { tablesToErDiagram } from "../dbErDiagram";
import { validateMermaid } from "../mermaidLoader";
import type { DbColumn, DbTable } from "../../types";

const col = (over: Partial<DbColumn> = {}): DbColumn =>
  ({
    id: "c1", table_id: "t1", name: "id", type: "uuid", nullable: false,
    is_primary_key: true, references_column_id: null, description: null, order: 0,
    ...over,
  }) as DbColumn;

const tbl = (over: Partial<DbTable> = {}): DbTable =>
  ({
    id: "t1", node_id: "n1", name: "orders", schema_name: "", description: null,
    version: 1, columns: [col()], ...over,
  }) as DbTable;

describe("tablesToErDiagram", () => {
  it("таблица с колонками: ключи и смысл значения попадают в диаграмму", () => {
    const out = tablesToErDiagram([
      tbl({
        columns: [
          col(),
          col({ id: "c2", name: "status", type: "varchar(16)", nullable: true,
            is_primary_key: false, description: "new|paid|shipped" }),
        ],
      }),
    ]);
    expect(out).toBe([
      "erDiagram",
      '  "orders" {',
      "    uuid id PK",
      '    varchar(16) status "new|paid|shipped"',
      "  }",
    ].join("\n"));
  });

  it("контур входит в имя сущности", () => {
    const out = tablesToErDiagram([tbl({ schema_name: "billing" })]);
    expect(out).toContain('"billing.orders"');
  });

  it("внешний ключ даёт связь; обязательность различает кардинальность", () => {
    const parent = tbl({ id: "t2", name: "accounts", columns: [col({ id: "c9" })] });
    const обязательный = tbl({
      columns: [col({ id: "c2", name: "account_id", type: "uuid", nullable: false,
        is_primary_key: false, references_column_id: "c9" })],
    });
    expect(tablesToErDiagram([обязательный, parent]))
      .toContain('"orders" }|--|| "accounts" : "account_id"');

    const необязательный = tbl({
      columns: [col({ id: "c2", name: "account_id", type: "uuid", nullable: true,
        is_primary_key: false, references_column_id: "c9" })],
    });
    expect(tablesToErDiagram([необязательный, parent]))
      .toContain('"orders" }o--|| "accounts" : "account_id"');
  });

  it("ссылка на исчезнувшую колонку связь не рождает", () => {
    const out = tablesToErDiagram([
      tbl({ columns: [col({ references_column_id: "нет-такой" })] }),
    ]);
    expect(out).not.toContain("--");
  });

  it("пустая структура — валидная пустая диаграмма", () => {
    expect(tablesToErDiagram([])).toBe("erDiagram");
  });

  // Ради этого теста и делались пробы парсером: тип обязателен, пробелы и кавычки
  // в идентификаторах ломают разбор. Всё это должно быть обезврежено генератором.
  it("недружелюбные имена не ломают разбор (настоящий парсер mermaid)", async () => {
    const out = tablesToErDiagram([
      tbl({
        name: 'заказы "клиентов"',
        schema_name: "публичный контур",
        columns: [
          col({ name: "код заказа", type: "", description: 'он же "ключ"' }),
          col({ id: "c2", name: "статус", type: "строка", nullable: true,
            is_primary_key: false, references_column_id: "c9" }),
        ],
      }),
      tbl({ id: "t2", name: "счета", columns: [col({ id: "c9", name: "ид" })] }),
    ]);
    // Парсер принимает и «uuid код заказа» (прочтёт «код» типом, «заказа» именем),
    // поэтому одной проверки синтаксиса мало — фиксируем и сам вывод.
    expect(out).toContain("    _ код_заказа");
    expect(out).toContain('"публичный контур.заказы клиентов"');
    expect(await validateMermaid(out)).toBeNull();
  });
});
