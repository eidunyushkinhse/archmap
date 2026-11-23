import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import UpdateNotice, { UPDATE_NOTICE } from "../UpdateNotice";

describe("UpdateNotice (аудит R-7)", () => {
  it("молчит, пока чанки грузятся; на vite:preloadError — плашка с кнопкой", () => {
    render(<UpdateNotice />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => {
      window.dispatchEvent(new Event("vite:preloadError"));
    });

    expect(screen.getByRole("status")).toHaveTextContent(UPDATE_NOTICE);
    expect(screen.getByRole("button", { name: "Обновить" })).toBeInTheDocument();
  });

  // Вид (редизайн, фаза 13а): тост нового языка внизу окна, кнопка «Обновить» — ds-btn.
  it("вид: тост ds-toast внизу окна, кнопка ds-btn, без инлайн-стилей", () => {
    render(<UpdateNotice />);
    act(() => {
      window.dispatchEvent(new Event("vite:preloadError"));
    });
    const плашка = screen.getByRole("status");
    expect(плашка).toHaveClass("ds-toast", "ds-toast--action", "ds-toast--service-bottom");
    expect(плашка).not.toHaveAttribute("style");
    const кнопка = screen.getByRole("button", { name: "Обновить" });
    expect(кнопка).toHaveClass("ds-btn");
    expect(кнопка).not.toHaveClass("ds-btn--primary");
    expect(кнопка).not.toHaveAttribute("style");
  });
});
