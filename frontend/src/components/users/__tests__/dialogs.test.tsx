// Окна админки и профиля: «Сменить пароль», «Новый пользователь», «Сбросить пароль».
// Проверяем, что уходит в API и как показываются отказы бэка.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import ChangePasswordDialog from "../ChangePasswordDialog";
import NewUserDialog from "../NewUserDialog";
import ResetPasswordDialog from "../ResetPasswordDialog";
import { changePassword } from "../../../api/auth";
import { adminApi } from "../../../api/admin";
import type { AdminUser } from "../../../types";

vi.mock("../../../api/auth", () => ({ changePassword: vi.fn() }));
vi.mock("../../../api/admin", () => ({
  adminApi: { create: vi.fn(), resetPassword: vi.fn() },
}));
vi.mock("../../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const ivan: AdminUser = {
  id: "u-ivan",
  username: "ivan",
  role: "viewer",
  is_admin: false,
  is_active: true,
  created_at: "2026-09-30T10:00:00+00:00",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ChangePasswordDialog", () => {
  async function fill(old: string, next: string, repeat: string) {
    await userEvent.type(screen.getByLabelText("Текущий пароль"), old);
    await userEvent.type(screen.getByLabelText("Новый пароль"), next);
    await userEvent.type(screen.getByLabelText("Повторите новый пароль"), repeat);
  }

  it("повтор не совпал: подсказка и кнопка неактивна", async () => {
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    await fill("old-password", "new-password-1", "new-password-2");
    expect(screen.getByText("Пароли не совпадают")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Сменить" })).toBeDisabled();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("успех: уходит старый и новый пароль, окно говорит «Пароль изменён»", async () => {
    vi.mocked(changePassword).mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ChangePasswordDialog onClose={onClose} />);
    await fill("old-password", "new-password-1", "new-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(changePassword).toHaveBeenCalledWith("old-password", "new-password-1");
    expect(await screen.findByText("Пароль изменён")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("отказ бэка показывается как есть (неверный текущий, короткий новый)", async () => {
    vi.mocked(changePassword).mockRejectedValue(new Error("Неверный текущий пароль"));
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    await fill("wrong", "new-password-1", "new-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(await screen.findByText("Неверный текущий пароль")).toBeInTheDocument();
    // окно осталось открытым с формой — можно поправить и повторить
    expect(screen.getByRole("button", { name: "Сменить" })).toBeEnabled();
  });
});

describe("NewUserDialog", () => {
  it("создаёт пользователя: логин без пробелов по краям, роль, админ, пароль", async () => {
    const created: AdminUser = { ...ivan, role: "architect", is_admin: true };
    vi.mocked(adminApi.create).mockResolvedValue(created);
    const onCreated = vi.fn();
    render(<NewUserDialog onClose={vi.fn()} onCreated={onCreated} />);
    await userEvent.type(screen.getByLabelText("Логин"), "  ivan ");
    await userEvent.selectOptions(screen.getByLabelText("Роль"), "architect");
    await userEvent.click(screen.getByLabelText("Администратор"));
    await userEvent.type(screen.getByLabelText("Временный пароль"), "temp-pass-1");
    await userEvent.click(screen.getByRole("button", { name: "Создать" }));
    expect(adminApi.create).toHaveBeenCalledWith({
      username: "ivan",
      role: "architect",
      is_admin: true,
      password: "temp-pass-1",
    });
    expect(onCreated).toHaveBeenCalledWith(created);
  });

  it("по умолчанию — наблюдатель без админки; кнопка неактивна без логина и пароля", async () => {
    render(<NewUserDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText("Роль")).toHaveValue("viewer");
    expect(screen.getByLabelText("Администратор")).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Создать" })).toBeDisabled();
  });

  it("отказ бэка (дубль логина) показывается в окне", async () => {
    vi.mocked(adminApi.create).mockRejectedValue(new Error("Пользователь с таким логином уже есть"));
    const onCreated = vi.fn();
    render(<NewUserDialog onClose={vi.fn()} onCreated={onCreated} />);
    await userEvent.type(screen.getByLabelText("Логин"), "ivan");
    await userEvent.type(screen.getByLabelText("Временный пароль"), "temp-pass-1");
    await userEvent.click(screen.getByRole("button", { name: "Создать" }));
    expect(await screen.findByText("Пользователь с таким логином уже есть")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });
});

describe("ResetPasswordDialog", () => {
  it("сбрасывает пароль выбранному пользователю", async () => {
    vi.mocked(adminApi.resetPassword).mockResolvedValue(undefined);
    const onDone = vi.fn();
    render(<ResetPasswordDialog user={ivan} onClose={vi.fn()} onDone={onDone} />);
    expect(screen.getByText(/Новый пароль для «ivan»/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Новый пароль"), "reset-pass-1");
    await userEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(adminApi.resetPassword).toHaveBeenCalledWith("u-ivan", "reset-pass-1");
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("короткий пароль: текст бэка в окне", async () => {
    vi.mocked(adminApi.resetPassword).mockRejectedValue(new Error("Пароль должен быть не короче 8 символов"));
    const onDone = vi.fn();
    render(<ResetPasswordDialog user={ivan} onClose={vi.fn()} onDone={onDone} />);
    await userEvent.type(screen.getByLabelText("Новый пароль"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(await screen.findByText("Пароль должен быть не короче 8 символов")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });
});
