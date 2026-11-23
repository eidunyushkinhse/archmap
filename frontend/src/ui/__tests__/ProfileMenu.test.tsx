// Меню профиля: видимость пунктов. «Сменить пароль» и «Токены для MCP» — у всех,
// «Пользователи» — только администратору (и только там, где есть куда вести).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import ProfileMenu from "../ProfileMenu";

function open() {
  return userEvent.click(screen.getByLabelText("Профиль"));
}

describe("ProfileMenu", () => {
  // Редизайн, фаза 5: кружок 28px и меню нового языка; корень — своя область .ds, поэтому
  // меню одинаково в шапке проекта и в шапках «Проектов» и «Пользователей».
  it("кружок и меню нового языка, корень — область .ds", async () => {
    const { container } = render(<ProfileMenu role="Архитектор" onLogout={vi.fn()} onChangePassword={vi.fn()} />);
    const avatar = screen.getByLabelText("Профиль");
    expect(avatar).toHaveClass("ds-avatar");
    expect(avatar.getAttribute("style")).toBeNull();
    expect(avatar).toHaveTextContent("А");
    expect(container.firstElementChild).toHaveClass("ds");
    await open();
    expect(avatar).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu");
    expect(menu).toHaveClass("ds-menu");
    expect(menu.getAttribute("style")).toBeNull();
    for (const it of screen.getAllByRole("menuitem")) expect(it).toHaveClass("ds-menu-item");
    expect(screen.getByText("Архитектор")).toHaveClass("ds-menu-head");
    expect(menu.querySelectorAll(".ds-menu-sep")).toHaveLength(2);
  });

  it("Escape и клик мимо закрывают меню", async () => {
    render(<ProfileMenu role="Архитектор" onLogout={vi.fn()} />);
    await open();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await open();
    await userEvent.click(document.body);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("наблюдателю без админки: «Сменить пароль» и «Выйти», без «Пользователи»", async () => {
    render(
      <ProfileMenu role="Наблюдатель" onLogout={vi.fn()} onChangePassword={vi.fn()} onOpenUsers={vi.fn()} />,
    );
    await open();
    expect(screen.getByRole("menuitem", { name: "Сменить пароль" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Выйти" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Пользователи" })).not.toBeInTheDocument();
    expect(screen.queryByText("Администратор")).not.toBeInTheDocument();
  });

  it("администратору: пункт «Пользователи» и отметка в шапке меню", async () => {
    const onOpenUsers = vi.fn();
    render(
      <ProfileMenu role="Архитектор" isAdmin onLogout={vi.fn()} onChangePassword={vi.fn()} onOpenUsers={onOpenUsers} />,
    );
    await open();
    expect(screen.getByText("Администратор")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Пользователи" }));
    expect(onOpenUsers).toHaveBeenCalledTimes(1);
    // пункт закрывает меню
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("администратору на самом экране «Пользователи» пункта нет (некуда вести)", async () => {
    render(<ProfileMenu role="Архитектор" isAdmin onLogout={vi.fn()} onChangePassword={vi.fn()} />);
    await open();
    expect(screen.queryByRole("menuitem", { name: "Пользователи" })).not.toBeInTheDocument();
  });

  it("«Токены для MCP» зовёт свой колбэк и закрывает меню", async () => {
    const onOpenTokens = vi.fn();
    render(<ProfileMenu role="Наблюдатель" onLogout={vi.fn()} onChangePassword={vi.fn()} onOpenTokens={onOpenTokens} />);
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "Токены для MCP" }));
    expect(onOpenTokens).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  // Страховка механики меню перед общим хуком клавиатуры (редизайн, фаза 13в): зелёная и
  // до него, и после.
  it("механика: кнопка открывает и закрывает, Escape и щелчок мимо закрывают, пункт закрывает и зовёт действие", async () => {
    const onChangePassword = vi.fn();
    render(<><ProfileMenu role="Архитектор" onLogout={vi.fn()} onChangePassword={onChangePassword} /><p>снаружи</p></>);
    const кнопка = screen.getByLabelText("Профиль");
    await userEvent.click(кнопка);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(кнопка);
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(кнопка);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(кнопка);
    await userEvent.click(screen.getByText("снаружи"));
    expect(screen.queryByRole("menu")).toBeNull();
    await userEvent.click(кнопка);
    await userEvent.click(screen.getByRole("menuitem", { name: "Сменить пароль" }));
    expect(onChangePassword).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("«Сменить пароль» и «Выйти» зовут свои колбэки", async () => {
    const onChangePassword = vi.fn();
    const onLogout = vi.fn();
    render(<ProfileMenu role="Архитектор" onLogout={onLogout} onChangePassword={onChangePassword} />);
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "Сменить пароль" }));
    expect(onChangePassword).toHaveBeenCalledTimes(1);
    await open();
    await userEvent.click(screen.getByRole("menuitem", { name: "Выйти" }));
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
