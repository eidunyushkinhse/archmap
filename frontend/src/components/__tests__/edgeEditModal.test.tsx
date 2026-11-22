// Удаление связи со СТРАНИЦЫ объекта (модалка по клику на строку таблицы «Связи»).
//
// До 2026-08-11 удалить связь можно было только в редакторе-карте: модалка страницы
// правила концы, описание и технологию, а кнопки удаления не имела вовсе.
// Подтверждение живёт ВНУТРИ этой же модалки — вложенные <dialog> в проекте
// запрещены (cancel всплывает), и на странице нет undo, в отличие от редактора.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

// «Удалить связь» в подвале открывает вопрос, «Удалить» в вопросе подтверждает.
const ask = () => screen.getByRole("button", { name: "Удалить связь" });
const del = () => screen.getByRole("button", { name: "Удалить" });

// Окно сначала грузит связь, список связей и имена концов, потом показывает форму. Форма —
// другой <dialog>, чем окно «Загрузка», и открывается он эффектом Modal уже после того,
// как текст формы появился в DOM; закрытый диалог прячет свои роли. Поэтому ждём дешёвый
// признак: открыт диалог с кнопкой формы «Готово» (заголовок «Связь» есть и у окна
// «Загрузка»). Роли ищем уже синхронно. Прежде тесты ждали findByRole: каждый опрос
// строит дерево доступности, и под нагрузкой (полный прогон в хуке) первый тест файла не
// укладывался в секунду ожидания по умолчанию. Запас ожидания — на холодный старт, а не
// на расчёт ролей.
async function openModal() {
  const handlers = renderModal();
  await waitFor(
    () => expect(screen.getByText("Готово").closest("dialog")?.open).toBe(true),
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
  it("кнопка «Удалить связь» есть в модалке страницы", async () => {
    await openModal();

    expect(ask()).toBeTruthy();
  });

  it("первый клик только спрашивает — связь не трогаем", async () => {
    await openModal();

    await userEvent.click(ask());

    expect(edgesApi.delete).not.toHaveBeenCalled();
    expect(screen.getByText(/Удалить связь\?/)).toBeTruthy();
  });

  it("подтверждение удаляет, обновляет страницу и закрывает", async () => {
    const { onClose, onChanged } = await openModal();

    await userEvent.click(ask());
    await userEvent.click(del()); // уже в подтверждении

    await waitFor(() => expect(edgesApi.delete).toHaveBeenCalledWith("e1"));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("«Отмена» возвращает к правке, связь цела", async () => {
    await openModal();
    await userEvent.click(ask());

    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(edgesApi.delete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Готово" })).toBeTruthy();
  });

  it("отказ бэка показан, модалка не закрывается", async () => {
    vi.mocked(edgesApi.delete).mockRejectedValue(new Error("Связь занята"));
    const { onClose } = await openModal();

    await userEvent.click(ask());
    await userEvent.click(del());

    expect(await screen.findByText("Связь занята")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });
});

// Страховка фазы 9в редизайна (окно «Связь» на новом языке): что уходит в PATCH и когда
// окно закрывается. Тесты не опираются на вид окна: ждут кнопку «Готово», поля берут по
// порядку (описание, затем технология; поиск конца здесь заглушён), разворот — по
// подсказке кнопки, удаление — по началу имени кнопки. Зелёные и на прежнем окне.
describe("EdgeEditModal: страховка правки", () => {
  const CHAN = { ...EDGE, channel: "orders.events" };

  async function openForm() {
    const onClose = vi.fn();
    const onChanged = vi.fn();
    render(<EdgeEditModal edgeId="e1" onClose={onClose} onChanged={onChanged} />);
    await waitFor(
      () => expect(screen.getByText("Готово").closest("dialog")?.open).toBe(true),
      { timeout: 5000 },
    );
    const [desc, tech] = screen.getAllByRole("textbox");
    return { onClose, onChanged, desc, tech };
  }
  const body = () => JSON.stringify(vi.mocked(edgesApi.update).mock.calls[0]?.[1]);

  beforeEach(() => {
    vi.mocked(edgesApi.get).mockResolvedValue(CHAN as never);
    vi.mocked(edgesApi.list).mockResolvedValue([CHAN] as never);
  });

  it("описание: уход из поля шлёт правку с полным телом, канал не стирается", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...CHAN, label: "оплата", version: 2 } as never);
    const { desc, onChanged, onClose } = await openForm();

    await userEvent.clear(desc);
    await userEvent.type(desc, "оплата");
    await userEvent.tab();

    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledOnce());
    expect(vi.mocked(edgesApi.update).mock.calls[0]?.[0]).toBe("e1");
    expect(body()).toBe(
      '{"label":"оплата","technology":"REST","channel":"orders.events","source_id":"n1","target_id":"n2","base_version":1}',
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("технология: уход из поля шлёт правку; пустое поле уходит null", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...CHAN, technology: null, version: 2 } as never);
    const { tech } = await openForm();

    await userEvent.clear(tech);
    await userEvent.tab();

    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledOnce());
    expect(body()).toBe(
      '{"label":"создать заказ","technology":null,"channel":"orders.events","source_id":"n1","target_id":"n2","base_version":1}',
    );
  });

  it("уход из поля без правки ничего не шлёт", async () => {
    const { desc } = await openForm();

    await userEvent.click(desc);
    await userEvent.tab();

    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("разворот меняет концы местами сразу, описание, технология и канал на месте", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...CHAN, source_id: "n2", target_id: "n1", version: 2 } as never);
    const { onChanged } = await openForm();

    await userEvent.click(screen.getByTitle("Поменять местами «Откуда» и «Куда»"));

    await waitFor(() => expect(edgesApi.update).toHaveBeenCalledOnce());
    expect(body()).toBe(
      '{"label":"создать заказ","technology":"REST","channel":"orders.events","source_id":"n2","target_id":"n1","base_version":1}',
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it("«Готово» дожимает введённый текст и закрывает окно при успехе", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...CHAN, label: "оплата", technology: "gRPC", version: 2 } as never);
    const { desc, tech, onClose } = await openForm();
    // Ввод без ухода из поля: fireEvent.click не переводит фокус, коммит делает сама кнопка.
    fireEvent.change(desc, { target: { value: "оплата" } });
    fireEvent.change(tech, { target: { value: "gRPC" } });

    fireEvent.click(screen.getByRole("button", { name: "Готово" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(edgesApi.update).toHaveBeenCalledOnce();
    expect(body()).toBe(
      '{"label":"оплата","technology":"gRPC","channel":"orders.events","source_id":"n1","target_id":"n2","base_version":1}',
    );
  });

  it("«Готово» при отказе сервера окно не закрывает и показывает отказ", async () => {
    vi.mocked(edgesApi.update).mockRejectedValue(new Error("Сервер не принял правку"));
    const { tech, onClose } = await openForm();
    fireEvent.change(tech, { target: { value: "gRPC" } });

    fireEvent.click(screen.getByRole("button", { name: "Готово" }));

    expect(await screen.findByText("Сервер не принял правку")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("«Готово» без правок закрывает окно без запроса", async () => {
    const { onClose } = await openForm();

    await userEvent.click(screen.getByRole("button", { name: "Готово" }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("удаление: первый щелчок спрашивает, подтверждение шлёт DELETE и закрывает", async () => {
    const { onClose, onChanged } = await openForm();

    await userEvent.click(screen.getByRole("button", { name: /^Удалить/ }));
    expect(edgesApi.delete).not.toHaveBeenCalled();
    expect(screen.getByText(/Удалить связь\? Она исчезнет со схемы/)).toBeInTheDocument();
    // В вопросе одна кнопка удаления; «Готово» спрятана.
    expect(screen.queryByRole("button", { name: "Готово" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /^Удалить/ }));

    await waitFor(() => expect(edgesApi.delete).toHaveBeenCalledWith("e1"));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onChanged).toHaveBeenCalledOnce();
    expect(edgesApi.update).not.toHaveBeenCalled();
  });

  it("крестик закрывает окно без запросов", async () => {
    const { onClose } = await openForm();

    await userEvent.click(screen.getAllByRole("button", { name: "Закрыть" })[0]);

    expect(onClose).toHaveBeenCalledOnce();
    expect(edgesApi.update).not.toHaveBeenCalled();
    expect(edgesApi.delete).not.toHaveBeenCalled();
  });

  it("отказ загрузки: текст отказа и «Закрыть»", async () => {
    vi.mocked(edgesApi.get).mockRejectedValue(new Error("нет связи"));
    const onClose = vi.fn();
    render(<EdgeEditModal edgeId="e1" onClose={onClose} onChanged={vi.fn()} />);

    expect(await screen.findByText("Не удалось загрузить данные связи")).toBeInTheDocument();
    const close = screen.getAllByRole("button", { name: "Закрыть" });
    await userEvent.click(close[close.length - 1]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("EdgeEditModal: подтверждение по Enter", () => {
  it("Enter в поле технологии — как «Готово»: коммит и закрытие", async () => {
    vi.mocked(edgesApi.update).mockResolvedValue({ ...EDGE, technology: "gRPC", version: 2 } as never);
    const { onClose, onChanged } = await openModal();
    const tech = screen.getByPlaceholderText("не указана");

    await userEvent.clear(tech);
    await userEvent.type(tech, "gRPC{Enter}");

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(vi.mocked(edgesApi.update).mock.calls[0]?.[1]).toMatchObject({ technology: "gRPC" });
    expect(onChanged).toHaveBeenCalled();
  });

  it("пока окно спрашивает об удалении, Enter молчит", async () => {
    const { onClose } = await openModal();
    await userEvent.click(ask());

    await userEvent.type(screen.getByPlaceholderText("не указана"), "{Enter}");

    expect(edgesApi.update).not.toHaveBeenCalled();
    expect(edgesApi.delete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
