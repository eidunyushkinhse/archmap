// Кнопка промпта, когда браузер не дал записать в буфер (аудит R-6): на http:// не-
// localhost clipboard нет вовсе, Safari отбирает жест после await. Раньше отказ
// глотался — главная кнопка BYOA «не работала» без единого слова.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PromptCopyButton from "../docsImport/PromptCopyButton";
import { CopyFailed } from "../../lib/copyText";

describe("PromptCopyButton: буфер недоступен", () => {
  it("текст задания показывается для ручного копирования", async () => {
    const copy = vi.fn(() => Promise.reject(new CopyFailed("ТЕКСТ ЗАДАНИЯ")));
    render(<PromptCopyButton label="Скопировать задание" copiedLabel="Скопировано" kind="primary" copy={copy} />);

    await userEvent.click(screen.getByRole("button", { name: "Скопировать задание" }));

    expect(await screen.findByRole("status")).toHaveTextContent("скопируйте");
    expect(screen.getByLabelText("Текст задания")).toHaveValue("ТЕКСТ ЗАДАНИЯ");
    expect(screen.getByRole("button", { name: "Скопировать задание" })).toBeInTheDocument();
  });

  it("прочий отказ (запрос промпта) — без поля, его показывает окно", async () => {
    const copy = vi.fn(() => Promise.reject(new Error("500")));
    render(<PromptCopyButton label="Скопировать задание" copiedLabel="Скопировано" kind="primary" copy={copy} />);
    await userEvent.click(screen.getByRole("button", { name: "Скопировать задание" }));
    await Promise.resolve();
    expect(screen.queryByLabelText("Текст задания")).toBeNull();
  });
});
