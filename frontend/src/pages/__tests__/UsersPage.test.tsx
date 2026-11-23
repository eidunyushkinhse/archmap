// Экран «Пользователи»: таблица, правки строк через adminApi, подтверждения
// блокировки и снятия админа, запертые действия у себя и у последнего админа. Действия
// строки — пункты меню кнопки-значка (редизайн, фаза 12а).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
const olga = user("olga", { role: "architect", is_admin: true });
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

// Кнопка меню действий строки.
function кебаб(username: string): HTMLElement {
  return row(username).getByRole("button", { name: `Действия с пользователем ${username}` });
}

// Действие строки, готовое к нажатию: меню строки открыто, пункт найден.
async function действие(username: string, label: string): Promise<HTMLElement> {
  await userEvent.click(кебаб(username));
  return within(screen.getByRole("menu")).getByRole("menuitem", { name: label });
}

// Все действия строки заперты (идёт запись).
function заперты(username: string): boolean {
  return row(username).getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled);
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

  it("у себя «Заблокировать» и «Снять права администратора» заперты, причина второй строкой", async () => {
    await setup([boss, olga, ivan]);
    const block = await действие("boss", "Заблокировать");
    const revoke = screen.getByRole("menuitem", { name: "Снять права администратора" });
    expect(block).toBeDisabled();
    expect(revoke).toBeDisabled();
    expect(block).toHaveAccessibleDescription("Нельзя заблокировать себя");
    expect(revoke).toHaveAccessibleDescription("Нельзя снять права с себя");
    expect(within(block).getByText("Нельзя заблокировать себя")).toBeInTheDocument();
    expect(within(revoke).getByText("Нельзя снять права с себя")).toBeInTheDocument();
    // Прежней подсказки-обёртки нет.
    expect(block.parentElement).not.toHaveAttribute("title");
    // «Сбросить пароль» у себя доступен.
    expect(screen.getByRole("menuitem", { name: "Сбросить пароль" })).toBeEnabled();
    // у второго админа — доступны
    await userEvent.keyboard("{Escape}");
    expect(await действие("olga", "Снять права администратора")).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Заблокировать" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: "Заблокировать" })).not.toHaveAccessibleDescription();
  });

  it("у последнего активного админа пункты заперты, причина второй строкой", async () => {
    // Список глазами админа, которого уже разжаловали в другой вкладке: активный
    // админ один, и это не он сам.
    vi.mocked(adminApi.list).mockResolvedValue([olga, user("boss", { role: "architect" })]);
    vi.mocked(fetchMe).mockResolvedValue({ id: boss.id, username: "boss", role: "architect", is_admin: false, is_guest: false, can_create_project: true });
    render(<UsersPage onAllProjects={vi.fn()} onLogout={vi.fn()} />);
    await screen.findByTestId("user-row-olga");
    const block = await действие("olga", "Заблокировать");
    const revoke = screen.getByRole("menuitem", { name: "Снять права администратора" });
    expect(block).toBeDisabled();
    expect(revoke).toBeDisabled();
    expect(block).toHaveAccessibleDescription("Это последний администратор");
    expect(revoke).toHaveAccessibleDescription("Это последний администратор");
  });

  it("блокировка — через подтверждение", async () => {
    await setup([boss, ivan]);
    vi.mocked(adminApi.update).mockResolvedValue({ ...ivan, is_active: false });
    await userEvent.click(await действие("ivan", "Заблокировать"));
    expect(screen.queryByRole("menu")).toBeNull();
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
    await userEvent.click(await действие("olga", "Снять права администратора"));
    expect(screen.getByText("Снять права администратора с «olga»?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(adminApi.update).not.toHaveBeenCalled();
  });

  it("снятие админа — через подтверждение; отказ бэка виден в окне", async () => {
    await setup([boss, olga]);
    vi.mocked(adminApi.update).mockRejectedValue(new Error("Нельзя снять права с последнего администратора"));
    await userEvent.click(await действие("olga", "Снять права администратора"));
    await userEvent.click(screen.getByRole("button", { name: "Снять" }));
    expect(adminApi.update).toHaveBeenCalledWith("u-olga", { is_admin: false });
    expect(await screen.findByText("Нельзя снять права с последнего администратора")).toBeInTheDocument();
  });

  it("разблокировать и сделать админом — сразу, без подтверждения", async () => {
    await setup([boss, ivan, petr]);
    vi.mocked(adminApi.update).mockResolvedValueOnce({ ...petr, is_active: true });
    await userEvent.click(await действие("petr", "Разблокировать"));
    expect(adminApi.update).toHaveBeenCalledWith("u-petr", { is_active: true });
    await waitFor(() => expect(row("petr").getByText("Активен")).toBeInTheDocument());

    vi.mocked(adminApi.update).mockResolvedValueOnce({ ...ivan, is_admin: true });
    await userEvent.click(await действие("ivan", "Сделать администратором"));
    expect(adminApi.update).toHaveBeenCalledWith("u-ivan", { is_admin: true });
    await waitFor(() => expect(row("ivan").getByText("Да")).toBeInTheDocument());
    expect(await действие("ivan", "Снять права администратора")).toBeInTheDocument();
  });

  it("смена роли — выбором в строке", async () => {
    await setup([boss, ivan]);
    vi.mocked(adminApi.update).mockResolvedValue({ ...ivan, role: "architect" });
    await userEvent.selectOptions(row("ivan").getByLabelText("Роль ivan"), "architect");
    expect(adminApi.update).toHaveBeenCalledWith("u-ivan", { role: "architect" });
    await waitFor(() => expect(row("ivan").getByLabelText("Роль ivan")).toHaveValue("architect"));
  });

  it("у администратора роль не выбирается: он всегда архитектор", async () => {
    await setup([boss, olga, ivan]);
    for (const name of ["boss", "olga"]) {
      const роль = row(name).getByLabelText(`Роль ${name}`);
      expect(роль).toHaveValue("architect");
      expect(роль).toBeDisabled();
      expect(роль).toHaveAttribute("title", "Администратор всегда архитектор");
    }
    expect(row("ivan").getByLabelText("Роль ivan")).toBeEnabled();
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
    await userEvent.click(await действие("ivan", "Сбросить пароль"));
    expect(screen.getByText(/Новый пароль для «ivan»/)).toBeInTheDocument();
  });

  it("неадмину — текст отказа бэка", async () => {
    vi.mocked(adminApi.list).mockRejectedValue(new Error("Требуются права администратора"));
    vi.mocked(fetchMe).mockResolvedValue({ id: "u-x", username: "x", role: "viewer", is_admin: false, is_guest: false, can_create_project: false });
    render(<UsersPage onAllProjects={vi.fn()} onLogout={vi.fn()} />);
    expect(await screen.findByText("Требуются права администратора")).toBeInTheDocument();
  });

  // Страховка редизайна (фаза 12а): действие строки находит помощник действие(), тела
  // запросов, тосты и запертость во время записи не зависят от вида строки.
  it("сделать админом, разблокировать, сменить роль: тосты итога", async () => {
    await setup([boss, ivan, petr]);
    vi.mocked(adminApi.update).mockResolvedValueOnce({ ...ivan, is_admin: true });
    await userEvent.click(await действие("ivan", "Сделать администратором"));
    expect(adminApi.update).toHaveBeenLastCalledWith("u-ivan", { is_admin: true });
    expect(await screen.findByText("Права администратора выданы")).toBeInTheDocument();
    expect(row("ivan").getByText("Да")).toBeInTheDocument();

    vi.mocked(adminApi.update).mockResolvedValueOnce({ ...petr, is_active: true });
    await userEvent.click(await действие("petr", "Разблокировать"));
    expect(adminApi.update).toHaveBeenLastCalledWith("u-petr", { is_active: true });
    expect(await screen.findByText("Пользователь разблокирован")).toBeInTheDocument();

    vi.mocked(adminApi.update).mockResolvedValueOnce({ ...petr, is_active: true, role: "architect" });
    await userEvent.selectOptions(row("petr").getByLabelText("Роль petr"), "architect");
    expect(adminApi.update).toHaveBeenLastCalledWith("u-petr", { role: "architect" });
    expect(await screen.findByText("Роль изменена")).toBeInTheDocument();
    expect(adminApi.update).toHaveBeenCalledTimes(3);
  });

  // Страховка механики тоста (редизайн, фаза 13а, меняется только вид): тост итога — без
  // роли и без aria-live, гаснет ровно через 2,6 с.
  it("тост итога: без роли, гаснет через 2,6 с", async () => {
    await setup([boss, ivan]);
    vi.mocked(adminApi.update).mockResolvedValue({ ...ivan, role: "architect" });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => {
        fireEvent.change(row("ivan").getByLabelText("Роль ivan"), { target: { value: "architect" } });
      });
      const тост = screen.getByText("Роль изменена");
      expect(тост).toHaveClass("ds-toast", "ds-toast--bottom");
      expect(тост).not.toHaveClass("legacy-root");
      expect(тост).not.toHaveAttribute("style");
      expect(тост).not.toHaveAttribute("role");
      expect(тост).not.toHaveAttribute("aria-live");
      act(() => { vi.advanceTimersByTime(2599); });
      expect(screen.getByText("Роль изменена")).toBeInTheDocument();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.queryByText("Роль изменена")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("снятие прав после подтверждения: тело запроса, окно закрыто, тост, строка «Нет»", async () => {
    await setup([boss, olga]);
    vi.mocked(adminApi.update).mockResolvedValue({ ...olga, is_admin: false });
    await userEvent.click(await действие("olga", "Снять права администратора"));
    await userEvent.click(screen.getByRole("button", { name: "Снять" }));
    expect(adminApi.update).toHaveBeenCalledWith("u-olga", { is_admin: false });
    expect(await screen.findByText("Права администратора сняты")).toBeInTheDocument();
    expect(screen.queryByText("Снять права администратора с «olga»?")).toBeNull();
    expect(row("olga").getByText("Нет")).toBeInTheDocument();
  });

  it("отказ записи без окна — текстом на странице", async () => {
    await setup([boss, ivan]);
    vi.mocked(adminApi.update).mockRejectedValue(new Error("Пользователь не найден"));
    await userEvent.click(await действие("ivan", "Сделать администратором"));
    expect(await screen.findByText("Пользователь не найден")).toBeInTheDocument();
  });

  it("пока идёт запись, действия строк и список роли заперты", async () => {
    await setup([boss, ivan, petr]);
    let ответить: (u: AdminUser) => void = () => {};
    vi.mocked(adminApi.update).mockImplementation(() => new Promise<AdminUser>((res) => { ответить = res; }));
    await userEvent.click(await действие("petr", "Разблокировать"));
    expect(заперты("ivan")).toBe(true);
    expect(row("ivan").getByLabelText("Роль ivan")).toBeDisabled();
    ответить({ ...petr, is_active: true });
    await waitFor(() => expect(заперты("ivan")).toBe(false));
    expect(row("ivan").getByLabelText("Роль ivan")).toBeEnabled();
  });

  it("каркас нового языка: шапка ds-head, логотип ведёт ко всем проектам, главная кнопка без значка", async () => {
    const props = await setup([boss]);
    const шапка = document.querySelector("header.ds-head") as HTMLElement;
    expect(шапка.closest(".ds")).not.toBeNull();
    await userEvent.click(within(шапка).getByRole("button", { name: "Все проекты" }));
    expect(props.onAllProjects).toHaveBeenCalledTimes(1);
    const кнопка = screen.getByRole("button", { name: "Новый пользователь" });
    expect(кнопка).toHaveClass("ds-btn", "ds-btn--primary");
    expect(кнопка.querySelector("svg")).toBeNull();
  });

  it("таблица нового языка: в строке одна кнопка-значок, слова вместо пилюль", async () => {
    await setup([boss, ivan, petr]);
    expect(screen.getByRole("table")).toHaveClass("ds-table");
    for (const name of ["boss", "ivan", "petr"]) {
      const кнопки = row(name).getAllByRole("button");
      expect(кнопки).toHaveLength(1);
      expect(кнопки[0]).toHaveClass("ds-icon-btn");
      expect(кнопки[0]).toHaveAttribute("title", "Действия");
      expect(кнопки[0]).toHaveAttribute("aria-haspopup", "menu");
      expect(кнопки[0]).toHaveAttribute("aria-expanded", "false");
    }
    expect(row("boss").getByText("вы")).toHaveClass("lp-self");
    expect(row("petr").getByText("Заблокирован")).toHaveClass("lp-blocked");
    expect(row("ivan").getByText("Активен")).toHaveClass("lp-quiet");
    expect(row("ivan").getByText("Нет")).toHaveClass("lp-quiet");
    expect(row("boss").getByText("Да")).not.toHaveClass("lp-quiet");
    expect(row("ivan").getByLabelText("Роль ivan").closest(".ds-select")).not.toBeNull();
  });

  it("меню строки: пункты по порядку, опасный «Заблокировать»; Escape, щелчок мимо и выбор закрывают", async () => {
    await setup([boss, ivan, petr]);
    await userEvent.click(кебаб("ivan"));
    expect(кебаб("ivan")).toHaveAttribute("aria-expanded", "true");
    const меню = screen.getByRole("menu");
    expect(меню).toHaveClass("ds-menu", "ds-menu--end");
    expect(within(меню).getAllByRole("menuitem").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
      "Сбросить пароль", "Сделать администратором", "Заблокировать",
    ]);
    expect(within(меню).getByRole("menuitem", { name: "Заблокировать" })).toHaveClass("ds-menu-item", "ds-menu-item--danger");
    expect(within(меню).getByRole("menuitem", { name: "Сбросить пароль" })).not.toHaveClass("ds-menu-item--danger");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(кебаб("ivan")).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(кебаб("petr"));
    expect(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Разблокировать" })).not.toHaveClass("ds-menu-item--danger");
    await userEvent.click(screen.getByRole("heading", { level: 1 }));
    expect(screen.queryByRole("menu")).toBeNull();

    await userEvent.click(await действие("ivan", "Сбросить пароль"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(adminApi.update).not.toHaveBeenCalled();
  });

  // Страховка механики меню перед общим хуком клавиатуры (редизайн, фаза 13в): зелёная и
  // до него, и после. Escape, щелчок мимо и выбор пункта держит тест выше.
  it("меню строки: кнопка открывает и закрывает", async () => {
    await setup([boss, ivan]);
    await userEvent.click(кебаб("ivan"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.click(кебаб("ivan"));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(кебаб("ivan")).toHaveAttribute("aria-expanded", "false");
  });

  it("«Все проекты» ведёт обратно", async () => {
    const props = await setup([boss]);
    // У логотипа в шапке то же имя «Все проекты» (aria-label); здесь — кнопка-текст.
    await userEvent.click(screen.getByText("Все проекты"));
    expect(props.onAllProjects).toHaveBeenCalledTimes(1);
  });
});
