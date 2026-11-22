// Окно экспорта (схема, объект с вложенными, процесс): само грузит текст загрузчиком load,
// пока грузит — «Готовим экспорт», отказ — текстом, готовый текст — в блоке кода;
// «Скопировать» кладёт в буфер ровно показанный текст и ненадолго меняет надпись.
// Modal настоящий (test-setup открывает <dialog> атрибутом open).
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ExportModal from "../ExportModal";
import { copyText } from "../../lib/copyText";

vi.mock("../../lib/copyText", () => ({ copyText: vi.fn() }));

const ТЕКСТ = "nodes:\n  - name: Order API\n    description: очень длинная строка описания объекта\n";

// Загрузчик, который отвечает, когда скажет тест.
function отложенный() {
  let resolve: (v: { content: string }) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<{ content: string }>((res, rej) => { resolve = res; reject = rej; });
  return { load: vi.fn(() => promise), resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(copyText).mockResolvedValue(undefined);
});

describe("ExportModal", () => {
  it("загрузка: заголовок из пропа, «Готовим экспорт», затем текст; «Скопировать» заперта до текста", async () => {
    const d = отложенный();
    render(<ExportModal title="Экспорт схемы" loadKey="all" load={d.load} onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Экспорт схемы" })).toBeInTheDocument();
    expect(d.load).toHaveBeenCalled();
    expect(screen.getByText("Готовим экспорт")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Скопировать" })).toBeDisabled();
    await act(async () => d.resolve({ content: ТЕКСТ }));
    expect(screen.queryByText("Готовим экспорт")).not.toBeInTheDocument();
    // Текст показан целиком и без изменений (блок кода, переносов не добавляем).
    expect(document.querySelector("pre")?.textContent).toBe(ТЕКСТ);
    expect(screen.getByRole("button", { name: "Скопировать" })).toBeEnabled();
  });

  it("отказ: текст ошибки, блока с текстом нет, «Скопировать» заперта", async () => {
    const d = отложенный();
    render(<ExportModal title="Экспорт схемы" loadKey="all" load={d.load} onClose={vi.fn()} />);
    await act(async () => d.reject(new Error("Нет доступа к проекту")));
    expect(screen.getByText("Нет доступа к проекту")).toBeInTheDocument();
    expect(screen.queryByText("Готовим экспорт")).not.toBeInTheDocument();
    expect(document.querySelector("pre")).toBeNull();
    expect(screen.getByRole("button", { name: "Скопировать" })).toBeDisabled();
  });

  it("отказ без текста ошибки: «Не удалось выгрузить схему»", async () => {
    const d = отложенный();
    render(<ExportModal title="Экспорт схемы" loadKey="all" load={d.load} onClose={vi.fn()} />);
    await act(async () => d.reject("сеть"));
    expect(screen.getByText("Не удалось выгрузить схему")).toBeInTheDocument();
  });

  it("«Скопировать» кладёт в буфер показанный текст, надпись «Скопировано» держится и возвращается", async () => {
    render(<ExportModal title="Экспорт схемы" loadKey="all" load={() => Promise.resolve({ content: ТЕКСТ })} onClose={vi.fn()} />);
    const кнопка = await screen.findByRole("button", { name: "Скопировать" });
    await waitFor(() => expect(кнопка).toBeEnabled());
    await userEvent.click(кнопка);
    expect(copyText).toHaveBeenCalledTimes(1);
    expect(copyText).toHaveBeenCalledWith(ТЕКСТ);
    expect(await screen.findByRole("button", { name: /^Скопировано/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Скопировать" })).toBeInTheDocument(), { timeout: 3000 });
  });

  it("буфер недоступен: надпись не меняется, ошибки нет", async () => {
    vi.mocked(copyText).mockRejectedValue(new Error("нет буфера"));
    render(<ExportModal title="Экспорт схемы" loadKey="all" load={() => Promise.resolve({ content: ТЕКСТ })} onClose={vi.fn()} />);
    const кнопка = await screen.findByRole("button", { name: "Скопировать" });
    await waitFor(() => expect(кнопка).toBeEnabled());
    await userEvent.click(кнопка);
    expect(copyText).toHaveBeenCalledWith(ТЕКСТ);
    expect(screen.getByRole("button", { name: "Скопировать" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Скопировано/ })).not.toBeInTheDocument();
  });

  it("смена области: загрузчик зовётся заново, ответ прежней области не показывается", async () => {
    const первый = отложенный();
    const второй = отложенный();
    const { rerender } = render(<ExportModal title="Экспорт схемы" loadKey="all" load={первый.load} onClose={vi.fn()} />);
    rerender(<ExportModal title="Экспорт объекта с вложенными" loadKey="n1" load={второй.load} onClose={vi.fn()} />);
    expect(второй.load).toHaveBeenCalledTimes(1);
    await act(async () => первый.resolve({ content: "старое" }));
    expect(screen.getByText("Готовим экспорт")).toBeInTheDocument();
    expect(screen.queryByText("старое")).not.toBeInTheDocument();
    await act(async () => второй.resolve({ content: "новое" }));
    expect(document.querySelector("pre")?.textContent).toBe("новое");
  });

  it("«Закрыть» зовёт onClose", async () => {
    const onClose = vi.fn();
    render(<ExportModal title="Экспорт схемы" loadKey="all" load={() => Promise.resolve({ content: ТЕКСТ })} onClose={onClose} />);
    const закрыть = screen.getAllByRole("button", { name: "Закрыть" });
    // Кнопка подвала — последняя «Закрыть» в окне (крестик тоже называется «Закрыть»).
    await userEvent.click(закрыть[закрыть.length - 1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
