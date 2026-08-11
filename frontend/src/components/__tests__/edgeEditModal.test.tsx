// Удаление связи со СТРАНИЦЫ объекта (модалка по клику на строку таблицы «Связи»).
//
// До 2026-08-11 удалить связь можно было только в редакторе-карте: модалка страницы
// правила концы, описание и технологию, а кнопки удаления не имела вовсе.
// Подтверждение живёт ВНУТРИ этой же модалки — вложенные <dialog> в проекте
// запрещены (cancel всплывает), и на странице нет undo, в отличие от редактора.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import EdgeEditModal from "../EdgeEditModal";
import { edgesApi, nodesApi } from "../../api/nodes";

vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("../NodeSearchPicker", () => ({ default: () => null }));
vi.mock("../../api/nodes", () => ({
  edgesApi: { get: vi.fn(), list: vi.fn(), update: vi.fn(), delete: vi.fn() },
  nodesApi: { get: vi.fn() },
}));

const EDGE = {
  id: "e1", label: "создать заказ", technology: "REST",
  source_id: "n1", target_id: "n2", version: 1, is_synchronous: true,
};

function renderModal() {
  const onClose = vi.fn();
  const onChanged = vi.fn();
  render(<EdgeEditModal edgeId="e1" onClose={onClose} onChanged={onChanged} />);
  return { onClose, onChanged };
}

const del = () => screen.getByRole("button", { name: "Удалить" });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(edgesApi.get).mockResolvedValue(EDGE as never);
  vi.mocked(edgesApi.list).mockResolvedValue([EDGE] as never);
  vi.mocked(edgesApi.delete).mockResolvedValue(undefined as never);
  vi.mocked(nodesApi.get).mockResolvedValue({ name: "Узел" } as never);
});

describe("EdgeEditModal: удаление связи", () => {
  it("кнопка «Удалить» есть в модалке страницы", async () => {
    renderModal();

    expect(await screen.findByRole("button", { name: "Удалить" })).toBeTruthy();
  });

  it("первый клик только спрашивает — связь не трогаем", async () => {
    renderModal();
    await screen.findByRole("button", { name: "Удалить" });

    await userEvent.click(del());

    expect(edgesApi.delete).not.toHaveBeenCalled();
    expect(screen.getByText(/Удалить связь\?/)).toBeTruthy();
  });

  it("подтверждение удаляет, обновляет страницу и закрывает", async () => {
    const { onClose, onChanged } = renderModal();
    await screen.findByRole("button", { name: "Удалить" });

    await userEvent.click(del());
    await userEvent.click(del()); // тот же ярлык — уже в подтверждении

    await waitFor(() => expect(edgesApi.delete).toHaveBeenCalledWith("e1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("«Отмена» возвращает к правке, связь цела", async () => {
    renderModal();
    await screen.findByRole("button", { name: "Удалить" });
    await userEvent.click(del());

    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(edgesApi.delete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Готово" })).toBeTruthy();
  });

  it("отказ бэка показан, модалка не закрывается", async () => {
    vi.mocked(edgesApi.delete).mockRejectedValue(new Error("Связь занята"));
    const { onClose } = renderModal();
    await screen.findByRole("button", { name: "Удалить" });

    await userEvent.click(del());
    await userEvent.click(del());

    expect(await screen.findByText("Связь занята")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});
