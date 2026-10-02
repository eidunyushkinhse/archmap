// Экран «Пользователи»: таблица, правки строк через adminApi, подтверждения
// блокировки и снятия админа, отключённые кнопки у себя и у последнего админа.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import UsersPage from "../UsersPage";
import { adminApi } from "../../api/admin";
import { fetchMe } from "../../api/auth";
import type { AdminUser } from "../../types";

vi.mock("../../api/admin", () => ({
  adminApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), resetPassword: vi.fn() },
}));
vi.mock("../../api/auth", () => ({
  fetchMe: vi.fn(),
  getUserRole: vi.fn(() => "architect"),
  getIsAdmin: vi.fn(() => true),
  getIsGuest: vi.fn(() => false),
  changePassword: vi.fn(),
}));
vi.mock("../../ui/Modal", () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function user(username: string, fields: Partial<AdminUser> = {}): AdminUser {
  return {
    id: `u-${username}`,
    username,
    role: "viewer",
    is_admin: false,
    is_active: true,
    created_at: "2026-09-30T10:00:00+00:00",
    ...fields,
  };
}

const boss = user("boss", { role: "architect", is_admin: true });
const ivan = user("ivan");
const olga = user("olga", { is_admin: true });
const petr = user("petr", { is_active: false });

async function setup(list: AdminUser[]) {
  vi.mocked(adminApi.list).mockResolvedValue(list);
  vi.mocked(fetchMe).mockResolvedValue({ id: boss.id, username: "boss", role: "architect", is_admin: true, is_guest: false, can_create_project: true });
  const props = { onAllProjects: vi.fn(), onLogout: vi.fn() };
  render(<UsersPage {...props} />);
  await screen.findByTestId("user-row-boss");
  return props;
}

function row(username: string) {
  return within(screen.getByTestId(`user-row-${username}`));
}

describe("UsersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("таблица: логин, роль, админ, статус; своя строка помечена «вы»", async () => {
    await setup([boss, ivan, petr]);
    expect(row("boss").getByText("вы")).toBeInTheDocument();
    expect(row("boss").getByText("Да")).toBeInTheDocument();
    expect(row("ivan").getByText("Нет")).toBeInTheDocument();
    expect(row("ivan").getByText("Активен")).toBeInTheDocument();
    expect(row("petr").getByText("Заблокирован")).toBeInTheDocument();
    expect(row("ivan").getByLabelText("Роль ivan")).toHaveValue("viewer");
    expect(row("boss").getByLabelText("Роль boss")).toHaveValue("architect");
  });

  it("у себя «Заблокировать» и «Снять админа» отключены с подсказкой", async () => {
    await setup([boss, olga, ivan]);
    const block = row("boss").getByRole("button", { name: "Заблокировать" });
    const revoke = row("boss").getByRole("button", { name: "Снять админа" });
    expect(block).toBeDisabled();
    expect(revoke).toBeDisabled();
    expect(block.parentElement).toHaveAttribute("title", "Нельзя заблокировать себя");
    expect(revoke.parentElement).toHaveAttribute("title", "Нельзя снять права с себя");
    // у второго админа — доступны
    expect(row("olga").getByRole("button", { name: "Снять админа" })).toBeEnabled();
    expect(row("olga").getByRole("button", { name: "Заблокировать" })).toBeEnabled();
  });

  it("у последнего активного админа кнопки отключены с подсказкой", async () => {
    // Список глазами админа, которого уже разжаловали в другой вкладке: активный
    // админ один, и это не он сам.
    vi.mocked(adminApi.list).mockResolvedValue([olga, user("boss", { role: "architect" })]);
    vi.mocked(fetchMe).mockResolvedValue({ id: boss.id, username: "boss", role: "architect", is_admin: false, is_guest: false, can_create_project: true });
    render(<UsersPage onAllProjects={vi.fn()} onLogout={vi.fn()} />);
    await screen.findByTestId("user-row-olga");
    const block = row("olga").getByRole("button", { name: "Заблокировать" });
    const revoke = row("olga").getByRole("button", { name: "Снять админа" });
    expect(block).toBeDisabled();
    expect(revoke).toBeDisabled();
    expect(block.parentElement).toHaveAttribute("title", "Это последний администратор");
    expect(revoke.parentElement).toHaveAttribute("title", "Это последний администратор");
  });

  it("блокировка — через подтверждение", async () => {
    await setup([boss, ivan]);
    vi.mocked(adminApi.update).mockResolvedValue({ ...ivan, is_active: false });
    await userEvent.click(row("ivan").getByRole("button", { name: "Заблокировать" }));
    expect(screen.getByText("Заблокировать «ivan»?")).toBeInTheDocument();
    expect(adminApi.update).not.toHaveBeenCalled();
    // в окне подтверждения своя кнопка «Заблокировать» (danger)
    const confirm = screen.getAllByRole("button", { name: "Заблокировать" }).at(-1)!;
    await userEvent.click(confirm);
    expect(adminApi.update).toHaveBeenCalledWith("u-ivan", { is_active: false });
    await waitFor(() => expect(row("ivan").getByText("Заблокирован")).toBeInTheDocument());
    expect(screen.queryByText("Заблокировать «ivan»?")).not.toBeInTheDocument();
    expect(screen.getByText("Пользователь заблокирован")).toBeInTheDocument();
  });

  it("отмена подтверждения ничего не меняет", async () => {
    await setup([boss, olga]);
    await userEvent.click(row("olga").getByRole("button", { name: "Снять админа" }));
    expect(screen.getByText("Снять права администратора с «olga»?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(adminApi.update).not.toHaveBeenCalled();
  });

  it("снятие админа — через подтверждение; отказ бэка виден в окне", async () => {
    await setup([boss, olga]);
    vi.mocked(adminApi.update).mockRejectedValue(new Error("Нельзя снять права с последнего администратора"));
    await userEvent.click(row("olga").getByRole("button", { name: "Снять админа" }));
    await userEvent.click(screen.getByRole("button", { name: "Снять" }));
    expect(adminApi.update).toHaveBeenCalledWith("u-olga", { is_admin: false });
    expect(await screen.findByText("Нельзя снять права с последнего администратора")).toBeInTheDocument();
  });

  it("разблокировать и сделать админом — сразу, без подтверждения", async () => {
    await setup([boss, ivan, petr]);
    vi.mocked(adminApi.update).mockResolvedValueOnce({ ...petr, is_active: true });
    await userEvent.click(row("petr").getByRole("button", { name: "Разблокировать" }));
    expect(adminApi.update).toHaveBeenCalledWith("u-petr", { is_active: true });
    await waitFor(() => expect(row("petr").getByText("Активен")).toBeInTheDocument());

    vi.mocked(adminApi.update).mockResolvedValueOnce({ ...ivan, is_admin: true });
    await userEvent.click(row("ivan").getByRole("button", { name: "Сделать админом" }));
    expect(adminApi.update).toHaveBeenCalledWith("u-ivan", { is_admin: true });
    await waitFor(() => expect(row("ivan").getByRole("button", { name: "Снять админа" })).toBeInTheDocument());
  });

  it("смена роли — выбором в строке", async () => {
    await setup([boss, ivan]);
    vi.mocked(adminApi.update).mockResolvedValue({ ...ivan, role: "architect" });
    await userEvent.selectOptions(row("ivan").getByLabelText("Роль ivan"), "architect");
    expect(adminApi.update).toHaveBeenCalledWith("u-ivan", { role: "architect" });
    await waitFor(() => expect(row("ivan").getByLabelText("Роль ivan")).toHaveValue("architect"));
  });

  it("своя роль сменилась — «кто я» перечитывается", async () => {
    await setup([boss, olga]);
    vi.mocked(fetchMe).mockClear();
    vi.mocked(adminApi.update).mockResolvedValue({ ...boss, role: "viewer" });
    await userEvent.selectOptions(row("boss").getByLabelText("Роль boss"), "viewer");
    await waitFor(() => expect(fetchMe).toHaveBeenCalledTimes(1));
  });

  it("«Новый пользователь» добавляет строку", async () => {
    await setup([boss]);
    vi.mocked(adminApi.create).mockResolvedValue(ivan);
    await userEvent.click(screen.getByRole("button", { name: /Новый пользователь/ }));
    await userEvent.type(screen.getByLabelText("Логин"), "ivan");
    await userEvent.type(screen.getByLabelText("Временный пароль"), "temp-pass-1");
    await userEvent.click(screen.getByRole("button", { name: "Создать" }));
    expect(await screen.findByTestId("user-row-ivan")).toBeInTheDocument();
    expect(screen.getByText("Пользователь создан")).toBeInTheDocument();
  });

  it("«Сбросить пароль» открывает окно для этой строки", async () => {
    await setup([boss, ivan]);
    await userEvent.click(row("ivan").getByRole("button", { name: "Сбросить пароль" }));
    expect(screen.getByText(/Новый пароль для «ivan»/)).toBeInTheDocument();
  });

  it("неадмину — текст отказа бэка", async () => {
    vi.mocked(adminApi.list).mockRejectedValue(new Error("Требуются права администратора"));
    vi.mocked(fetchMe).mockResolvedValue({ id: "u-x", username: "x", role: "viewer", is_admin: false, is_guest: false, can_create_project: false });
    render(<UsersPage onAllProjects={vi.fn()} onLogout={vi.fn()} />);
    expect(await screen.findByText("Требуются права администратора")).toBeInTheDocument();
  });

  it("«Все проекты» ведёт обратно", async () => {
    const props = await setup([boss]);
    await userEvent.click(screen.getByRole("button", { name: "← Все проекты" }));
    expect(props.onAllProjects).toHaveBeenCalledTimes(1);
  });
});
