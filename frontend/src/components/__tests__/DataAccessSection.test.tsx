// Секция «Обращения к данным» на странице сервиса — ради неё весь эпик.
//
// Проверяется главное свойство модели: обращение описывается У ВЫЗЫВАЮЩЕГО (в доке его
// операции) и уходит на ЧУЖУЮ таблицу, а колонка при этом необязательна — «вся
// таблица» законный ответ (SELECT * обычен).
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DataAccessSection from "../DataAccessSection";
import { dataAccessApi, dbTablesApi } from "../../api/nodes";
import type { DataAccess, NodeDocMeta, ProjectTableRef } from "../../types";

vi.mock("../../api/nodes", () => ({
  dataAccessApi: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
  dbTablesApi: { catalog: vi.fn() },
}));

const doc = (over: Partial<NodeDocMeta> = {}): NodeDocMeta =>
  ({ id: "d1", name: "POST /pay", kind: "operation", operation: "POST /pay", version: 1, ...over }) as NodeDocMeta;

const catalog = (): ProjectTableRef[] => [
  {
    id: "t1", node_id: "db1", node_name: "Хранилище", name: "orders", schema_name: "",
    columns: [
      { id: "c1", table_id: "t1", name: "status", type: "varchar", nullable: true,
        is_primary_key: false, references_column_id: null, description: null, order: 0 },
    ],
  } as ProjectTableRef,
];

const access = (over: Partial<DataAccess> = {}): DataAccess =>
  ({ id: "a1", node_doc_id: "d1", table_id: "t1", column_id: "c1", mode: "write", note: null, ...over }) as DataAccess;

function setup(list: DataAccess[], isArchitect = true, docs = [doc()]) {
  vi.mocked(dataAccessApi.list).mockResolvedValue(list);
  vi.mocked(dbTablesApi.catalog).mockResolvedValue(catalog());
  return render(<DataAccessSection nodeId="svc" docs={docs} isArchitect={isArchitect} />);
}

describe("DataAccessSection", () => {
  beforeEach(() => vi.clearAllMocks());

  // Те же подписи есть и в пикере («Хранилище · orders» — вариант выбора, «читает» —
  // вариант действия), поэтому строку обращения читаем по её собственным классам.
  const строкаОбращения = (c: HTMLElement) => ({
    действие: c.querySelector(".dbs-mode")?.textContent,
    цель: c.querySelector(".dbs-usage, .dbs-cols")?.querySelector(".dbs-cname")?.textContent,
  });

  it("описанное обращение читается как «пишет Хранилище · orders.status»", async () => {
    const { container } = setup([access()]);
    await waitFor(() => expect(container.querySelector(".dbs-mode")).not.toBeNull());
    expect(строкаОбращения(container)).toEqual({
      действие: "пишет", цель: "Хранилище · orders.status",
    });
  });

  it("обращение к таблице целиком показывается без колонки", async () => {
    const { container } = setup([access({ column_id: null, mode: "read" })]);
    await waitFor(() => expect(container.querySelector(".dbs-mode")).not.toBeNull());
    expect(строкаОбращения(container)).toEqual({ действие: "читает", цель: "Хранилище · orders" });
  });

  it("новое обращение уходит с выбранной таблицей и колонкой", async () => {
    vi.mocked(dataAccessApi.create).mockResolvedValue(access());
    setup([]);
    await waitFor(() => expect(screen.getByLabelText("Таблица")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Таблица"), "t1");
    await userEvent.selectOptions(screen.getByLabelText("Колонка"), "c1");
    await userEvent.selectOptions(screen.getByLabelText("Что делает операция"), "write");
    await userEvent.click(screen.getByText("+ Обращение"));
    expect(dataAccessApi.create).toHaveBeenCalledWith("svc", "d1", {
      table_id: "t1", column_id: "c1", mode: "write",
    });
  });

  it("без выбранной таблицы добавить нельзя", async () => {
    setup([]);
    await waitFor(() => expect(screen.getByText("+ Обращение")).toBeInTheDocument());
    expect(screen.getByText("+ Обращение")).toBeDisabled();
  });

  it("без описанных таблиц секция говорит, с чего начать", async () => {
    vi.mocked(dataAccessApi.list).mockResolvedValue([]);
    vi.mocked(dbTablesApi.catalog).mockResolvedValue([]);
    render(<DataAccessSection nodeId="svc" docs={[doc()]} isArchitect />);
    await waitFor(() => expect(
      screen.getByText(/сначала опишите структуру базы/),
    ).toBeInTheDocument());
  });

  it("наблюдателю без обращений секции нет вовсе", async () => {
    const { container } = setup([], false);
    await waitFor(() => expect(dataAccessApi.list).toHaveBeenCalled());
    expect(container.querySelector(".np-card")).toBeNull();
  });
});
