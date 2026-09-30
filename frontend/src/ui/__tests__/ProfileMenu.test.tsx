// Меню профиля: видимость пунктов. «Сменить пароль» — у всех, «Пользователи» —
// только администратору (и только там, где есть куда вести).
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import ProfileMenu from "../ProfileMenu";

function open() {
  return userEvent.click(screen.getByLabelText("Профиль"));
}

describe("ProfileMenu", () => {
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
