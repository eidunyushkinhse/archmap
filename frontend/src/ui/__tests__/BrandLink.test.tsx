// Логотип ArchMap (ui/BrandLink): без onClick — знак и слово (список проектов, вход), с
// onClick — кнопка «Все проекты» (оболочка проекта, редактор, пользователи). Вид — классы
// ui/chrome.css на токенах (редизайн, фаза 13б): у строки, кнопки и слова инлайн-стилей нет
// (знак LogoMark — своя разметка ui/icons, его здесь не проверяем).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BrandLink from "../BrandLink";

describe("BrandLink", () => {
  it("без onClick: знак и слово «ArchMap» строкой brand, кнопки нет", () => {
    const { container } = render(<BrandLink />);
    expect(screen.queryByRole("button")).toBeNull();
    const row = container.firstElementChild;
    expect(row).toHaveClass("brand");
    expect(row).toHaveTextContent("ArchMap");
    expect(screen.getByText("Map")).toHaveClass("brand-word-accent");
    expect(screen.getByText("Map").parentElement).toHaveClass("brand-word");
    for (const el of [row, screen.getByText("Map"), screen.getByText("Map").parentElement]) {
      expect(el).not.toHaveAttribute("style");
    }
  });

  it("с onClick: кнопка «Все проекты» классами brand и brand-link, щелчок зовёт onClick", async () => {
    const onClick = vi.fn();
    render(<BrandLink onClick={onClick} />);
    const btn = screen.getByRole("button", { name: "Все проекты" });
    expect(btn).toHaveClass("brand", "brand-link");
    expect(btn).toHaveAttribute("type", "button");
    expect(btn).toHaveAttribute("title", "Все проекты");
    expect(btn).toHaveAttribute("data-tour", "logo");
    expect(btn).not.toHaveAttribute("style");
    expect(btn.querySelector(".brand-word")).not.toHaveAttribute("style");
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
