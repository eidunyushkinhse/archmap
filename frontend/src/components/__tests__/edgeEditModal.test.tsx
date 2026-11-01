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

// Modal настоящий (test-setup открывает <dialog> атрибутом open): подтверждение по Enter
// идёт через него.
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

// Окно сначала грузит связь, список связей и имена концов, потом показывает форму. Форма —
// другой <dialog>, чем окно «Загрузка…», и открывается он эффектом Modal уже после того,
// как текст формы появился в DOM; закрытый диалог прячет свои роли. Поэтому ждём дешёвый
// признак — диалог с заголовком формы открыт, — а роли ищем уже синхронно. Прежде тесты
// ждали findByRole: каждый опрос строит дерево доступности, и под нагрузкой (полный
// прогон в хуке) первый тест файла не укладывался в секунду ожидания по умолчанию. Запас
// ожидания — на холодный старт, а не на расчёт ролей.
async function openModal() {
  const handlers = renderModal();
  await waitFor(
    () => expect(screen.getByText("Редактирование связи").closest("dialog")?.open).toBe(true),
    { timeout: 5000 },
  );
  return handlers;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(edgesApi.get).mockResolvedValue(EDGE as never);
  vi.mocked(edgesApi.list).mockResolvedValue([EDGE] as never);
  vi.mocked(edgesApi.delete).mockResolvedValue(undefined as never);
  vi.mocked(nodesApi.get).mockResolvedValue({ name: "Узел" } as never);
});

describe("EdgeEditModal: удаление связи", () => {
  it("кнопка «Удалить» есть в модалке страницы", async () => {
    await openModal();

    expect(screen.getByRole("button", { name: "Удалить" })).toBeTruthy();
  });

  it("первый клик только спрашивает — связь не трогаем", async () => {
    await openModal();

    await userEvent.click(del());

    expect(edgesApi.delete).not.toHaveBeenCalled();
    expect(screen.getByText(/Удалить связь\?/)).toBeTruthy();
  });

  it("подтверждение удаляет, обновляет страницу и закрывает", async () => {
    const { onClose, onChanged } = await openModal();

    await userEvent.click(del());
    await userEvent.click(del()); // тот же ярлык — уже в подтверждении

    await waitFor(() => expect(edgesApi.delete).toHaveBeenCalledWith("e1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("«Отмена» возвращает к правке, связь цела", async () => {
    await openModal();
    await userEvent.click(del());

    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(edgesApi.delete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Готово" })).toBeTruthy();
  });

  it("отказ бэка показан, модалка не закрывается", async () => {
    vi.mocked(edgesApi.delete).mockRejectedValue(new Error("Связь занята"));
    const { onClose } = await openModal();

    await userEvent.click(del());
    await userEvent.click(del());

    expect(await screen.findByText("Связь занята")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("EdgeEditModal: подтверждение по Enter", () => {
  it("Enter в поле технологии — как «Готово»: коммит и закрытие", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...EDGE, technology: "gRPC", version: 2 } as never);
    const { onClose, onChanged } = await openModal();
    const tech = screen.getByPlaceholderText("REST, gRPC, Kafka…");

    await userEvent.clear(tech);
    await userEvent.type(tech, "gRPC{Enter}");

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(vi.mocked(edgesApi.update).mock.calls[0]?.[1]).toMatchObject({ technology: "gRPC" });
    expect(onChanged).toHaveBeenCalled();
  });

  it("пока окно спрашивает об удалении, Enter молчит", async () => {
    const { onClose } = await openModal();
    await userEvent.click(del());

    await userEvent.type(screen.getByPlaceholderText("REST, gRPC, Kafka…"), "{Enter}");

    expect(edgesApi.update).not.toHaveBeenCalled();
    expect(edgesApi.delete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
