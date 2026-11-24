// Текст диаграммы процесса на сторонах версии (находка 2, 2026-11-24): после «Заменить из
// Mermaid» прежний вариант лежит в версии проекта, и на вкладках «Было в vN» и «Стало…»
// элемента-процесса под таблицей шагов виден его текст с «Скопировать». Таблица шагов на
// «Изменениях» прежняя. Modal настоящий, API версий и буфер замоканы.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VersionsPanel from "../nodePage/versions/VersionsPanel";
import { versionsApi } from "../../api/versions";
import { CopyFailed, copyText } from "../../lib/copyText";
import type { VersionItem, VersionItemDetail, VersionView } from "../../types";

vi.mock("../../api/versions", () => ({
  versionsApi: {
    list: vi.fn(), create: vi.fn(), remove: vi.fn(), diff: vi.fn(), item: vi.fn(),
    restorePreview: vi.fn(), restore: vi.fn(),
  },
}));
vi.mock("../../lib/copyText", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/copyText")>()),
  copyText: vi.fn(),
}));

const OLD = "sequenceDiagram\n    participant P1 as Покупатель\n    participant P2 as Заказы\n    P1->>P2: оформить\n    P2-->>P1: принят";
const NEW = "sequenceDiagram\n    participant P1 as Покупатель\n    participant P2 as Заказы\n    P1->>P2: оформить";

const ITEM: VersionItem = {
  item_id: "process:p1", category: "process", node_path: "", name: "Оформление заказа",
  status: "changed", summary: "−1 шаг",
};
const steps = (rows: string[][]): VersionView => ({
  text: null, lines: null, columns: ["№", "Кто → кому", "Подпись"],
  rows: rows.map((cells) => ({ mark: "", cells, changed: [] })),
});
const DETAIL: VersionItemDetail = {
  item: ITEM,
  changes: {
    text: null, lines: null, columns: ["№", "Кто → кому", "Подпись"],
    rows: [{ mark: "del", cells: ["2", "Заказы → Покупатель", "принят"], changed: [] }],
    mermaid: null,
  },
  before: { ...steps([["1", "Покупатель → Заказы", "оформить"], ["2", "Заказы → Покупатель", "принят"]]), mermaid: OLD },
  after: { ...steps([["1", "Покупатель → Заказы", "оформить"]]), mermaid: NEW },
};

async function openItem() {
  vi.mocked(versionsApi.list).mockResolvedValue({
    versions: [{
      number: 1, comment: "Перед заменой процесса «Оформление заказа» из диаграммы", kind: "pre_replace",
      restored_from: null, created_at: "2026-11-24T10:00:00Z", author: "architect",
      stats: { nodes: 1, edges: 0, docs: 0, tables: 0, channels: 0, params: 0, processes: 1, changed: [] },
    }],
    pending: { changed: true, items: [] },
  });
  vi.mocked(versionsApi.diff).mockResolvedValue({
    base: { number: 1, comment: "", created_at: "" }, target: { number: null, comment: null, created_at: null }, items: [ITEM],
  });
  vi.mocked(versionsApi.item).mockResolvedValue(DETAIL);
  render(<VersionsPanel nodeId={null} title="Ярмарка" canEdit canDelete={false} onClose={vi.fn()} />);
  await userEvent.click(await screen.findByRole("button", { name: /^v1/ }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "С чем сравнивать" }), "live");
  await userEvent.click(await screen.findByRole("button", { name: /^Процесс/ }));
  return within(screen.getByRole("group", { name: "Что показать" })).getAllByRole("button");
}

const codeText = () => document.querySelector("section[aria-label='Текст диаграммы'] pre.vp-code")?.textContent;

describe("элемент-процесс версии: текст диаграммы", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("«Было в v1» и «Стало сейчас»: таблица шагов и под ней текст варианта; «Изменения» без текста", async () => {
    const segs = await openItem();
    expect(segs.map((b) => b.textContent)).toEqual(["Изменения", "Было в v1", "Стало сейчас"]);
    expect(await screen.findByRole("cell", { name: "принят" })).toBeInTheDocument();
    expect(codeText()).toBeUndefined();
    expect(screen.queryByRole("button", { name: "Скопировать" })).toBeNull();

    await userEvent.click(segs[1]);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(codeText()).toBe(OLD);
    expect(screen.getByText(/Чтобы вернуть этот вариант процесса/)).toHaveClass("vp-mmd-hint");

    await userEvent.click(segs[2]);
    expect(codeText()).toBe(NEW);
  });

  it("«Скопировать» кладёт в буфер текст этой стороны; отказ буфера — подсказка скопировать вручную", async () => {
    vi.mocked(copyText).mockResolvedValue(undefined);
    const segs = await openItem();
    await userEvent.click(segs[1]);
    await userEvent.click(screen.getByRole("button", { name: "Скопировать" }));
    expect(copyText).toHaveBeenLastCalledWith(OLD);
    expect(screen.getByRole("button", { name: "Скопировано" })).toBeInTheDocument();
    // Другая вкладка — своя кнопка, ещё не нажатая.
    await userEvent.click(segs[2]);
    vi.mocked(copyText).mockRejectedValue(new CopyFailed(NEW));
    await userEvent.click(screen.getByRole("button", { name: "Скопировать" }));
    expect(copyText).toHaveBeenLastCalledWith(NEW);
    expect(await screen.findByText("Браузер не дал скопировать. Выделите текст и скопируйте вручную.")).toHaveClass("ds-warn");
  });
});
