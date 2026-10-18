// AccountMenu: меню профиля читает роль и признак администратора из кэша «кто я»
// (api/auth) и открывает окна «Сменить пароль» и «Токены для MCP».
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AccountMenu from "../AccountMenu";
import { getIsAdmin, getUserRole } from "../../../api/auth";
import { tokensApi } from "../../../api/tokens";

vi.mock("../../../api/auth", () => ({
  getUserRole: vi.fn(() => "architect"),
  getIsAdmin: vi.fn(() => false),
  getIsGuest: vi.fn(() => false),
  changePassword: vi.fn(),
}));
vi.mock("../../../api/tokens", () => ({
  tokensApi: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
}));
// Модалка — прозрачная обёртка: jsdom не выставляет содержимое <dialog> в a11y-дерево.
vi.mock("../../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("AccountMenu", () => {
  beforeEach(() => {
    vi.mocked(getUserRole).mockReturnValue("architect");
    vi.mocked(getIsAdmin).mockReturnValue(false);
  });

  it("не администратору пункта «Пользователи» нет", async () => {
    render(<AccountMenu onLogout={vi.fn()} onOpenUsers={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("Профиль"));
    expect(screen.getByText("Архитектор")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Пользователи" })).not.toBeInTheDocument();
  });

  it("администратору пункт «Пользователи» ведёт на экран", async () => {
    vi.mocked(getIsAdmin).mockReturnValue(true);
    const onOpenUsers = vi.fn();
    render(<AccountMenu onLogout={vi.fn()} onOpenUsers={onOpenUsers} />);
    await userEvent.click(screen.getByLabelText("Профиль"));
    // у администратора полные права — роль не показывается, только «Администратор»
    expect(screen.getByText("Администратор")).toBeInTheDocument();
    expect(screen.queryByText("Архитектор")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: "Пользователи" }));
    expect(onOpenUsers).toHaveBeenCalledTimes(1);
  });

  it("«Сменить пароль» открывает окно, «Отмена» закрывает", async () => {
    render(<AccountMenu onLogout={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("Профиль"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Сменить пароль" }));
    expect(screen.getByLabelText("Текущий пароль")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(screen.queryByLabelText("Текущий пароль")).not.toBeInTheDocument();
  });

  it("«Токены для MCP» открывает окно, «Закрыть» закрывает", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([]);
    render(<AccountMenu onLogout={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("Профиль"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Токены для MCP" }));
    expect(await screen.findByLabelText("Название")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Закрыть" }));
    expect(screen.queryByLabelText("Название")).not.toBeInTheDocument();
  });

  it("архитектору «Только чтение» на выбор, «Пользователю» — включено и закрыто", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([]);
    const { unmount } = render(<AccountMenu onLogout={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("Профиль"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Токены для MCP" }));
    expect(await screen.findByLabelText("Только чтение")).toBeEnabled();
    unmount();

    vi.mocked(getUserRole).mockReturnValue("viewer");
    render(<AccountMenu onLogout={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("Профиль"));
    await userEvent.click(screen.getByRole("menuitem", { name: "Токены для MCP" }));
    const ro = await screen.findByLabelText("Только чтение");
    expect(ro).toBeChecked();
    expect(ro).toBeDisabled();
  });
});
