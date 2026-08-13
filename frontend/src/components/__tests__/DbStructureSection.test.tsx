// Секция «Структура» узла-базы: таблицы и колонки записями.
//
// Проверяется то, что отличает эту секцию от текстового поля: правка идёт поштучно
// (без формы и «Сохранить»), таблица правится под CAS, колонка умеет ссылаться на
// чужую колонку (из этих ссылок Ф3 рисует ER), а наблюдатель ничего не редактирует.
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DbStructureSection from "../DbStructureSection";
import { dbTablesApi } from "../../api/nodes";
import type { DbColumn, DbTable, TableUsage } from "../../types";

// Рендерер mermaid тяжёлый и грузится динамическим import() — в тестах секции он не
// нужен: сам генератор проверен отдельно (dbErDiagram.test.ts).
vi.mock("../MermaidRenderer", () => ({
  default: ({ chart }: { chart: string }) => <pre data-testid="er">{chart}</pre>,
}));
// Полноэкранное окно: проверяем, что клик его открывает и текст диаграммы тот же
// (сам пан/зум — общая механика превью доков, у неё свои тесты).
vi.mock("../ErDiagramModal", () => ({
  default: ({ chart, onClose }: { chart: string; onClose: () => void }) => (
    <div data-testid="er-full" onClick={onClose}>{chart}</div>
  ),
}));
vi.mock("../../api/nodes", () => ({
  dbTablesApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    createColumn: vi.fn(),
    usage: vi.fn(() => Promise.resolve([])),
    updateColumn: vi.fn(),
    deleteColumn: vi.fn(),
  },
}));

function column(over: Partial<DbColumn> = {}): DbColumn {
  return {
    id: "c1", table_id: "t1", name: "status", type: "varchar(16)",
    nullable: true, is_primary_key: false, references_column_id: null,
    description: null, order: 0, ...over,
  } as DbColumn;
}

function table(over: Partial<DbTable> = {}): DbTable {
  return {
    id: "t1", node_id: "n1", name: "orders", schema_name: "",
    description: null, version: 1, columns: [column()], ...over,
  } as DbTable;
}

function setup(tables: DbTable[], isArchitect = true) {
  vi.mocked(dbTablesApi.list).mockResolvedValue(tables);
  return render(<DbStructureSection nodeId="n1" nodeName="Хранилище" isArchitect={isArchitect} />);
}

describe("DbStructureSection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("пустая структура предлагает завести таблицу", async () => {
    setup([]);
    await waitFor(() => expect(screen.getByText("Таблицы не описаны")).toBeInTheDocument());
    expect(screen.getByText("+ Таблица")).toBeInTheDocument();
  });

  it("колонки видны после раскрытия таблицы, число — сразу", async () => {
    setup([table()]);
    await waitFor(() => expect(screen.getByDisplayValue("orders")).toBeInTheDocument());
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("status")).toBeNull();
    await userEvent.click(screen.getByLabelText("Развернуть колонки"));
    expect(screen.getByDisplayValue("status")).toBeInTheDocument();
  });

  it("у списка колонок есть шапка — иначе тип не отличить от смысла", async () => {
    setup([table()]);
    await waitFor(() => expect(screen.getByDisplayValue("orders")).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Развернуть колонки"));
    for (const заголовок of ["Колонка", "Тип", "ключ", "обяз.", "Ссылается на", "Смысл значения"]) {
      expect(screen.getByText(заголовок)).toBeInTheDocument();
    }
    // Признаки названы ОДИН раз — в шапке. В строках только сами чекбоксы: подпись
    // «PK» в каждой строке читалась столбиком-шумом.
    expect(screen.getByLabelText("Первичный ключ")).toBeInTheDocument();
    expect(screen.queryByText("PK")).toBeNull();
    expect(screen.queryByText("NOT NULL")).toBeNull();
  });

  it("разделы становятся раскрывашками, но только когда они заданы", async () => {
    // У баз без такого уровня (Redis, Elasticsearch) лишней вложенности быть не должно.
    setup([table(), table({ id: "t2", name: "invoices" })]);
    await waitFor(() => expect(screen.getByDisplayValue("orders")).toBeInTheDocument());
    expect(screen.queryByText("без раздела")).toBeNull();
  });

  it("свёрнутый раздел прячет свои таблицы", async () => {
    // Тело раздела ведёт свою высоту само (useCollapse) — по окончании анимации
    // содержимое уходит из DOM, а список и карточка секции просто следуют за ним.
    setup([table(), table({ id: "t2", name: "audit", schema_name: "billing" })]);
    await waitFor(() => expect(screen.getByDisplayValue("orders")).toBeInTheDocument());
    await userEvent.click(screen.getByText("billing"));
    const box = screen.getByDisplayValue("audit").closest(".dbs-groupbody") as HTMLElement;
    expect(box.style.height).toBe("0px");
  });

  it("с разделами таблицы группируются", async () => {
    setup([table(), table({ id: "t2", name: "audit", schema_name: "billing" })]);
    await waitFor(() => expect(screen.getByDisplayValue("orders")).toBeInTheDocument());
    expect(screen.getByText("без раздела")).toBeInTheDocument();
    expect(screen.getByText("billing")).toBeInTheDocument();
  });

  it("правка имени таблицы уходит PATCH-ем с CAS-версией", async () => {
    vi.mocked(dbTablesApi.update).mockResolvedValue(table({ name: "invoices" }));
    setup([table({ version: 7 })]);
    const input = await screen.findByDisplayValue("orders");
    fireEvent.blur(input, { target: { value: "invoices" } });
    await waitFor(() => expect(dbTablesApi.update).toHaveBeenCalledWith(
      "n1", "t1", { name: "invoices", base_version: 7 },
    ));
  });

  it("новая таблица получает свободное имя — повторное нажатие не упрётся в 409", async () => {
    vi.mocked(dbTablesApi.create).mockResolvedValue(table());
    setup([table({ id: "t1", name: "таблица" })]);
    await waitFor(() => expect(screen.getByDisplayValue("таблица")).toBeInTheDocument());
    await userEvent.click(screen.getByText("+ Таблица"));
    expect(dbTablesApi.create).toHaveBeenCalledWith("n1", { name: "таблица_2", schema_name: "" });
  });

  it("колонка ссылается на колонку другой таблицы, но не на себя", async () => {
    vi.mocked(dbTablesApi.updateColumn).mockResolvedValue(column());
    setup([
      table(),
      table({
        id: "t2", name: "accounts",
        columns: [column({ id: "c2", table_id: "t2", name: "id" })],
      }),
    ]);
    await waitFor(() => expect(screen.getByDisplayValue("orders")).toBeInTheDocument());
    await userEvent.click(screen.getAllByLabelText("Развернуть колонки")[0]);
    const fk = screen.getByTitle("Ссылается на колонку");
    // Своей же колонки в списке нет — ссылка на себя бессмысленна.
    expect(screen.queryByRole("option", { name: "orders.status" })).toBeNull();
    await userEvent.selectOptions(fk, "c2");
    expect(dbTablesApi.updateColumn).toHaveBeenCalledWith(
      "n1", "t1", "c1", { references_column_id: "c2" },
    );
  });

  it("диаграмма показывается по кнопке и собирается из тех же записей", async () => {
    setup([table()]);
    await waitFor(() => expect(screen.getByDisplayValue("orders")).toBeInTheDocument());
    expect(screen.queryByTestId("er")).toBeNull();
    await userEvent.click(screen.getByText("Показать диаграмму"));
    expect(screen.getByTestId("er").textContent).toContain('"orders"');
  });

  it("клик по диаграмме открывает её во весь экран", async () => {
    setup([table()]);
    await waitFor(() => expect(screen.getByDisplayValue("orders")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Показать диаграмму"));
    expect(screen.queryByTestId("er-full")).toBeNull();
    await userEvent.click(screen.getByTitle("Открыть диаграмму во весь экран"));
    expect(screen.getByTestId("er-full").textContent).toContain('"orders"');
  });

  it("наблюдатель видит структуру, но не правит", async () => {
    setup([table({ columns: [column({ is_primary_key: true, nullable: false })] })], false);
    await waitFor(() => expect(screen.getByText("orders")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("orders")).toBeNull();
    expect(screen.queryByText("+ Таблица")).toBeNull();
    // И колонки тоже читаются, а не правятся: признаки — текстом, полей ввода нет.
    await userEvent.click(screen.getByLabelText("Развернуть колонки"));
    expect(screen.getByText("status")).toBeInTheDocument();
    expect(screen.getByText("PK")).toBeInTheDocument();
    expect(screen.getByText("NOT NULL")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("status")).toBeNull();
    expect(screen.queryByTitle("Ссылается на колонку")).toBeNull();
  });
});

// ── Обратный индекс ──────────────────────────────────────────────────────────
// Разворот тех же обращений: перечень таблиц говорит, ГДЕ значение может лежать,
// а этот блок — КТО его туда кладёт. Ради него весь эпик.
describe("DbStructureSection: кто обращается", () => {
  beforeEach(() => vi.clearAllMocks());

  const usage = (over: Partial<TableUsage> = {}): TableUsage =>
    ({
      table_id: "t1", table_name: "orders", column_id: "c1", column_name: "status",
      mode: "write", doc_id: "d1", doc_name: "POST /pay",
      node_id: "svc", node_name: "Биллинг", ...over,
    }) as TableUsage;

  it("показывает, кто пишет в колонку", async () => {
    vi.mocked(dbTablesApi.list).mockResolvedValue([table()]);
    vi.mocked(dbTablesApi.usage).mockResolvedValue([usage()]);
    render(<DbStructureSection nodeId="n1" nodeName="Хранилище" isArchitect />);
    await waitFor(() => expect(screen.getByDisplayValue("orders")).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Развернуть колонки"));
    expect(screen.getByText("orders.status")).toBeInTheDocument();
    expect(screen.getByText("Биллинг · POST /pay")).toBeInTheDocument();
  });

  it("без обращений так и говорит — молчание значило бы «никто не ходит»", async () => {
    vi.mocked(dbTablesApi.list).mockResolvedValue([table()]);
    vi.mocked(dbTablesApi.usage).mockResolvedValue([]);
    render(<DbStructureSection nodeId="n1" nodeName="Хранилище" isArchitect />);
    await waitFor(() => expect(screen.getByDisplayValue("orders")).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText("Развернуть колонки"));
    expect(screen.getByText("Обращений не описано")).toBeInTheDocument();
  });
});
