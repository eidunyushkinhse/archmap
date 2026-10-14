// Кнопка промпта, когда браузер не дал записать в буфер (аудит R-6): на http:// не-
// localhost clipboard нет вовсе, Safari отбирает жест после await. Раньше отказ
// глотался — главная кнопка BYOA «не работала» без единого слова.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PromptCopyButton from "../docsImport/PromptCopyButton";
import { CopyFailed } from "../../lib/copyText";

describe("PromptCopyButton: буфер недоступен", () => {
  it("текст промпта показывается для ручного копирования", async () => {
    const copy = vi.fn(() => Promise.reject(new CopyFailed("ТЕКСТ ПРОМПТА")));
    render(<PromptCopyButton label="Скопировать промпт" copiedLabel="Скопировано" kind="primary" copy={copy} />);

    await userEvent.click(screen.getByRole("button", { name: "Скопировать промпт" }));

    expect(await screen.findByRole("status")).toHaveTextContent("скопируйте");
    expect(screen.getByLabelText("Текст промпта")).toHaveValue("ТЕКСТ ПРОМПТА");
    expect(screen.getByRole("button", { name: "Скопировать промпт" })).toBeInTheDocument();
  });

  it("прочий отказ (запрос промпта) — без поля, его показывает окно", async () => {
    const copy = vi.fn(() => Promise.reject(new Error("500")));
    render(<PromptCopyButton label="Скопировать промпт" copiedLabel="Скопировано" kind="primary" copy={copy} />);
    await userEvent.click(screen.getByRole("button", { name: "Скопировать промпт" }));
    await Promise.resolve();
    expect(screen.queryByLabelText("Текст промпта")).toBeNull();
  });
});
