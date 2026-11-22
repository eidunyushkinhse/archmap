// Окна админки и профиля: «Сменить пароль», «Новый пользователь», «Сбросить пароль».
// Проверяем, что уходит в API и как показываются отказы бэка.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
// Modal настоящий (test-setup открывает <dialog> атрибутом open): подтверждение по Enter
// идёт через него.

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

  it("Enter в поле — как «Сменить»; пока повтор не совпал, клавиша молчит", async () => {
    vi.mocked(changePassword).mockResolvedValue(undefined);
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    await fill("old-password", "new-password-1", "new-password-2{Enter}");
    expect(changePassword).not.toHaveBeenCalled();
    const repeat = screen.getByLabelText("Повторите новый пароль");
    await userEvent.clear(repeat);
    await userEvent.type(repeat, "new-password-1{Enter}");
    expect(changePassword).toHaveBeenCalledWith("old-password", "new-password-1");
    expect(await screen.findByText("Пароль изменён")).toBeInTheDocument();
  });

  // Страховка редизайна (фаза 9д): механика окна не меняется вместе с видом.
  it("«Сменить» заперта, пока не введены все три поля; без текущего пароля — тоже", async () => {
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Сменить" });
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Новый пароль"), "new-password-1");
    await userEvent.type(screen.getByLabelText("Повторите новый пароль"), "new-password-1");
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Текущий пароль"), "old-password");
    expect(btn).toBeEnabled();
    expect(screen.getByText("Не короче 8 символов")).toBeInTheDocument();
  });

  it("поля пароля: порядок, id, autoComplete и type для менеджеров паролей", () => {
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    const fields = [...document.querySelectorAll("input")];
    expect(fields.map((f) => [f.id, f.type, f.getAttribute("autocomplete")])).toEqual([
      ["cp-old", "password", "current-password"],
      ["cp-new", "password", "new-password"],
      ["cp-repeat", "password", "new-password"],
    ]);
    expect(fields[0]).toHaveAttribute("data-autofocus");
  });

  it("после успеха: «Пароль изменён», пояснение и «Готово» в фокусе по умолчанию", async () => {
    vi.mocked(changePassword).mockResolvedValue(undefined);
    render(<ChangePasswordDialog onClose={vi.fn()} />);
    await fill("old-password", "new-password-1", "new-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Сменить" }));
    expect(await screen.findByText("Остальные активные сессии завершены.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Готово" })).toHaveAttribute("data-autofocus");
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
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created));
    // окно закрывает родитель — до тех пор кнопка не оживает (второй щелчок не повторит запрос)
    expect(screen.getByRole("button", { name: "Создаём" })).toBeDisabled();
  });

  it("администратор — всегда архитектор: роль подставлена и закрыта", async () => {
    vi.mocked(adminApi.create).mockResolvedValue({ ...ivan, role: "architect", is_admin: true });
    render(<NewUserDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByLabelText("Роль")).toHaveValue("viewer");
    await userEvent.click(screen.getByLabelText("Администратор"));
    expect(screen.getByLabelText("Роль")).toHaveValue("architect");
    expect(screen.getByLabelText("Роль")).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Логин"), "ivan");
    await userEvent.type(screen.getByLabelText("Временный пароль"), "temp-pass-1");
    await userEvent.click(screen.getByRole("button", { name: "Создать" }));
    expect(adminApi.create).toHaveBeenCalledWith({ username: "ivan", role: "architect", is_admin: true, password: "temp-pass-1" });
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
    expect(screen.getByRole("button", { name: "Создать" })).toBeEnabled();
  });

  // Страховка редизайна (фаза 9д): механика окна не меняется вместе с видом.
  it("«Создать» заперта без пароля, без логина и при логине из одних пробелов", async () => {
    render(<NewUserDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "Создать" });
    await userEvent.type(screen.getByLabelText("Логин"), "ivan");
    expect(btn).toBeDisabled();
    await userEvent.clear(screen.getByLabelText("Логин"));
    await userEvent.type(screen.getByLabelText("Временный пароль"), "temp-pass-1");
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Логин"), "   ");
    expect(btn).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Логин"), "ivan");
    expect(btn).toBeEnabled();
  });

  it("поля: порядок, id, autoComplete, открытый пароль; роли списком; подсказка о пароле", () => {
    render(<NewUserDialog onClose={vi.fn()} onCreated={vi.fn()} />);
    const login = screen.getByLabelText("Логин");
    const password = screen.getByLabelText("Временный пароль");
    expect([login.id, login.getAttribute("type") ?? "text", login.getAttribute("autocomplete")]).toEqual(["nu-login", "text", "off"]);
    expect(login).toHaveAttribute("data-autofocus");
    expect([password.id, password.getAttribute("type") ?? "text", password.getAttribute("autocomplete")]).toEqual(["nu-password", "text", "off"]);
    expect(password).toHaveAttribute("spellcheck", "false");
    expect(screen.getByLabelText("Роль").id).toBe("nu-role");
    expect([...screen.getByLabelText("Роль").querySelectorAll("option")].map((o) => [o.value, o.textContent])).toEqual([
      ["architect", "Архитектор"],
      ["viewer", "Пользователь"],
    ]);
    const order = [...document.querySelectorAll("input, select")].map((f) => f.id || (f as HTMLInputElement).type);
    expect(order.indexOf("nu-login")).toBeLessThan(order.indexOf("nu-role"));
    expect(order.indexOf("nu-role")).toBeLessThan(order.indexOf("nu-password"));
    expect(screen.getByText("Не короче 8 символов. Передайте пароль человеку сами, сменить его можно в меню профиля.")).toBeInTheDocument();
  });

  it("«Отмена» закрывает окно без запроса", async () => {
    const onClose = vi.fn();
    render(<NewUserDialog onClose={onClose} onCreated={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(adminApi.create).not.toHaveBeenCalled();
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
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Сохраняем" })).toBeDisabled();
  });

  it("короткий пароль: текст бэка в окне", async () => {
    vi.mocked(adminApi.resetPassword).mockRejectedValue(new Error("Пароль должен быть не короче 8 символов"));
    const onDone = vi.fn();
    render(<ResetPasswordDialog user={ivan} onClose={vi.fn()} onDone={onDone} />);
    await userEvent.type(screen.getByLabelText("Новый пароль"), "short");
    await userEvent.click(screen.getByRole("button", { name: "Сбросить" }));
    expect(await screen.findByText("Пароль должен быть не короче 8 символов")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Сбросить" })).toBeEnabled();
  });

  // Страховка редизайна (фаза 9д): механика окна не меняется вместе с видом.
  it("пустой пароль — «Сбросить» заперта, Enter молчит; пояснение и подсказка прежние", async () => {
    render(<ResetPasswordDialog user={ivan} onClose={vi.fn()} onDone={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Сбросить" })).toBeDisabled();
    const field = screen.getByLabelText("Новый пароль");
    expect([field.id, field.getAttribute("type") ?? "text", field.getAttribute("autocomplete")]).toEqual(["rp-password", "text", "off"]);
    expect(field).toHaveAttribute("data-autofocus");
    await userEvent.type(field, "{Enter}");
    expect(adminApi.resetPassword).not.toHaveBeenCalled();
    expect(screen.getByText(
      "Новый пароль для «ivan». Передайте его человеку сами. Все активные сессии пользователя будут завершены.",
    )).toBeInTheDocument();
    expect(screen.getByText("Не короче 8 символов")).toBeInTheDocument();
  });

  it("«Отмена» закрывает окно без запроса", async () => {
    const onClose = vi.fn();
    render(<ResetPasswordDialog user={ivan} onClose={onClose} onDone={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(adminApi.resetPassword).not.toHaveBeenCalled();
  });
});
