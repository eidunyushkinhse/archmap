// Окно «Токены для MCP»: секрет показывается один раз (потом в списке — только
// префикс), отзыв — через подтверждение, отказы бэка видны в окне.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import AgentTokensDialog from "../AgentTokensDialog";
import { tokensApi } from "../../../api/tokens";
import type { PersonalToken } from "../../../types";

vi.mock("../../../api/tokens", () => ({
  tokensApi: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
}));
// Modal настоящий (test-setup открывает <dialog> атрибутом open).

const SECRET = "archmap_Zx9secretsecretsecretsecretsecret0000";

function token(over: Partial<PersonalToken> = {}): PersonalToken {
  return {
    id: "t-1",
    name: "Агент",
    prefix: "archmap_Zx9se",
    read_only: false,
    ci_only: false,
    created_at: "2026-10-17T10:00:00+00:00",
    last_used_at: null,
    expires_at: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AgentTokensDialog", () => {
  it("список: название, префикс, «только чтение», срок; название нового — свободное «Агент 2»", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([
      token(),
      token({ id: "t-2", name: "Читатель", prefix: "archmap_Ab1cd", read_only: true, expires_at: "2027-01-15T10:00:00+00:00" }),
    ]);
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    const reader = await screen.findByTestId("token-Читатель");
    expect(within(reader).getByText("archmap_Ab1cd…")).toBeInTheDocument();
    expect(within(reader).getByText("только чтение")).toBeInTheDocument();
    expect(within(reader).getByText(/до 15 янв/)).toBeInTheDocument();
    const agent = screen.getByTestId("token-Агент");
    expect(within(agent).getByText("не использовался · бессрочно")).toBeInTheDocument();
    expect(within(agent).queryByText("только чтение")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Название")).toHaveValue("Агент 2");
  });

  it("выпуск: уходят название, «только чтение» и срок; секрет и строки подключения — один раз", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([]);
    const issued = token({ name: "Ноутбук", read_only: true, expires_at: "2026-11-16T10:00:00+00:00" });
    vi.mocked(tokensApi.create).mockResolvedValue({ token: issued, secret: SECRET });
    const onClose = vi.fn();
    render(<AgentTokensDialog readOnlyOnly={false} onClose={onClose} />);
    // пустой список не печатается, сразу форма
    await waitFor(() => expect(tokensApi.list).toHaveBeenCalled());
    expect(screen.queryByText("Новый токен")).not.toBeInTheDocument();

    const name = screen.getByLabelText("Название");
    await userEvent.clear(name);
    await userEvent.type(name, "  Ноутбук ");
    await userEvent.selectOptions(screen.getByLabelText("Доступ"), "read");
    await userEvent.selectOptions(screen.getByLabelText("Срок действия"), "30");
    await userEvent.click(screen.getByRole("button", { name: "Выпустить токен" }));

    expect(tokensApi.create).toHaveBeenCalledWith({
      name: "Ноутбук", read_only: true, ci_only: false, lifetime_days: 30,
    });
    expect(await screen.findByText("Токен выпущен")).toBeInTheDocument();
    const url = `${window.location.origin}/mcp`;
    expect(screen.getByTestId("issued-secret")).toHaveTextContent(SECRET);
    // CLI — общая команда mcp add, имя программы — заглушка
    expect(screen.getByTestId("issued-cli")).toHaveTextContent(
      `<cli> mcp add --transport http archmap ${url} --header "Authorization: Bearer ${SECRET}"`,
    );
    // Desktop — второй вкладкой, общий блок mcpServers
    expect(screen.queryByTestId("issued-desktop")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Desktop" }));
    expect(screen.getByRole("tab", { name: "Desktop" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("issued-cli")).not.toBeInTheDocument();
    const json = JSON.parse(screen.getByTestId("issued-desktop").textContent ?? "") as unknown;
    expect(json).toEqual({
      mcpServers: { archmap: { url, headers: { Authorization: `Bearer ${SECRET}` } } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("при следующем открытии секрета нет — только префикс", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([token({ name: "Ноутбук" })]);
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    expect(await screen.findByText("archmap_Zx9se…")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SECRET))).not.toBeInTheDocument();
  });

  it("«Пользователю» — только чтение: выбор доступа закрыт, уходит read_only", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([]);
    vi.mocked(tokensApi.create).mockResolvedValue({ token: token({ read_only: true }), secret: SECRET });
    render(<AgentTokensDialog readOnlyOnly onClose={vi.fn()} />);
    const access = await screen.findByLabelText("Доступ");
    expect(access).toHaveValue("read");
    expect(access).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Выпустить токен" }));
    expect(tokensApi.create).toHaveBeenCalledWith({
      name: "Агент", read_only: true, ci_only: false, lifetime_days: 90,
    });
  });

  it("токен для CI: имя «CI», после выпуска строки CI вместо подключения агента", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([token({ name: "CI" })]);
    vi.mocked(tokensApi.create).mockResolvedValue({
      token: token({ id: "t-3", name: "CI 2", ci_only: true }), secret: SECRET,
    });
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    await userEvent.selectOptions(await screen.findByLabelText("Доступ"), "ci");
    // имя «CI» занято: подставляется следующее свободное
    expect(screen.getByLabelText("Название")).toHaveValue("CI 2");
    await userEvent.click(screen.getByRole("button", { name: "Выпустить токен" }));
    expect(tokensApi.create).toHaveBeenCalledWith({
      name: "CI 2", read_only: false, ci_only: true, lifetime_days: 90,
    });

    expect(await screen.findByText("Сигнал из CI после слияния в main")).toBeInTheDocument();
    const gitlab = screen.getByTestId("issued-gitlab").textContent ?? "";
    expect(gitlab).toContain(`curl -fsS -X POST "${window.location.origin}/api/v1/code-changes"`);
    expect(gitlab).toContain("$CI_PROJECT_URL");
    // секрет в строки CI не вписан: он лежит в переменной CI
    expect(gitlab).not.toContain(SECRET);
    expect(gitlab).toContain("$ARCHMAP_TOKEN");
    await userEvent.click(screen.getByRole("tab", { name: "GitHub" }));
    expect(screen.getByTestId("issued-github")).toHaveTextContent("secrets.ARCHMAP_TOKEN");
    expect(screen.queryByRole("tab", { name: "Desktop" })).not.toBeInTheDocument();
  });

  it("отказ бэка при выпуске виден под формой, окно остаётся", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([]);
    vi.mocked(tokensApi.create).mockRejectedValue(new Error("Токен с таким именем у вас уже есть"));
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Выпустить токен" }));
    expect(await screen.findByText("Токен с таким именем у вас уже есть")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выпустить токен" })).toBeEnabled();
  });

  it("пустое название — выпускать нечего", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([]);
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    await userEvent.clear(await screen.findByLabelText("Название"));
    expect(screen.getByRole("button", { name: "Выпустить токен" })).toBeDisabled();
  });

  it("отзыв — через подтверждение; «Отмена» ничего не шлёт", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([token(), token({ id: "t-2", name: "Ноутбук" })]);
    vi.mocked(tokensApi.revoke).mockResolvedValue(undefined);
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Отозвать Ноутбук" }));
    expect(screen.getByText("Отозвать токен «Ноутбук»?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(tokensApi.revoke).not.toHaveBeenCalled();
    expect(screen.queryByText("Отозвать токен «Ноутбук»?")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Отозвать Ноутбук" }));
    await userEvent.click(screen.getByRole("button", { name: "Отозвать" }));
    expect(tokensApi.revoke).toHaveBeenCalledWith("t-2");
    await waitFor(() => expect(screen.queryByTestId("token-Ноутбук")).not.toBeInTheDocument());
    expect(screen.getByTestId("token-Агент")).toBeInTheDocument();
    expect(tokensApi.list).toHaveBeenCalledTimes(1);
  });

  it("отказ бэка при отзыве виден в подтверждении, токен остаётся в списке", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([token()]);
    vi.mocked(tokensApi.revoke).mockRejectedValue(new Error("Нет связи с сервером"));
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Отозвать Агент" }));
    await userEvent.click(screen.getByRole("button", { name: "Отозвать" }));
    expect(await screen.findByText("Нет связи с сервером")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отозвать" })).toBeEnabled();
    expect(screen.getByTestId("token-Агент")).toBeInTheDocument();
  });

  // Страховка редизайна (фаза 9д): механика окна не меняется вместе с видом.
  it("токен CI: «сигнал из CI»; строка срока — когда пользовались и до какого числа", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([
      token({ id: "t-ci", name: "CI", prefix: "archmap_Ci56G", ci_only: true,
        last_used_at: "2026-11-12T12:00:00+00:00", expires_at: "2027-02-12T12:00:00+00:00" }),
    ]);
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    const ci = await screen.findByTestId("token-CI");
    expect(within(ci).getByText("сигнал из CI")).toBeInTheDocument();
    expect(within(ci).queryByText("только чтение")).not.toBeInTheDocument();
    expect(within(ci).getByText(/^использовался 12 нояб\. 2026 г\./)).toHaveTextContent(/до 12 февр\. 2027 г\.$/);
    expect(within(ci).getByRole("button", { name: "Отозвать CI" })).toHaveTextContent("Отозвать");
    // Заголовок блока выпуска есть, только когда список не пуст.
    expect(screen.getByText("Новый токен")).toBeInTheDocument();
  });

  it("подтверждение отзыва — соседнее окно, а не вложенное в окно токенов", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([token()]);
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Отозвать Агент" }));
    const dialogs = [...document.querySelectorAll("dialog")];
    expect(dialogs).toHaveLength(2);
    expect(dialogs[0].contains(dialogs[1])).toBe(false);
    expect(dialogs[1].contains(dialogs[0])).toBe(false);
    expect(screen.getByText("Агент с этим токеном сразу потеряет доступ.")).toBeInTheDocument();
  });

  it("пока список грузится — «Загрузка», выпускать нельзя", async () => {
    vi.mocked(tokensApi.list).mockReturnValue(new Promise<PersonalToken[]>(() => {}));
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    expect(screen.getByText("Загрузка")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выпустить токен" })).toBeDisabled();
  });

  it("название из пробелов — выпускать нечего; срок «Год» уходит числом дней", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([]);
    vi.mocked(tokensApi.create).mockResolvedValue({ token: token(), secret: SECRET });
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    const name = await screen.findByLabelText("Название");
    await userEvent.clear(name);
    await userEvent.type(name, "   ");
    const issue = screen.getByRole("button", { name: "Выпустить токен" });
    expect(issue).toBeDisabled();
    await userEvent.clear(name);
    await userEvent.type(name, "Ноутбук");
    await userEvent.selectOptions(screen.getByLabelText("Срок действия"), "365");
    await userEvent.click(issue);
    expect(tokensApi.create).toHaveBeenCalledWith({
      name: "Ноутбук", read_only: false, ci_only: false, lifetime_days: 365,
    });
  });

  it("поля: id, автофокус названия, предел длины; варианты срока и доступа", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([]);
    const onClose = vi.fn();
    render(<AgentTokensDialog readOnlyOnly={false} onClose={onClose} />);
    const name = await screen.findByLabelText("Название");
    expect(name.id).toBe("tok-name");
    expect(name).toHaveAttribute("data-autofocus");
    expect(name).toHaveAttribute("maxlength", "64");
    const life = screen.getByLabelText("Срок действия");
    expect(life.id).toBe("tok-life");
    expect(life).toHaveValue("90");
    expect([...life.querySelectorAll("option")].map((o) => [o.value, o.textContent])).toEqual([
      ["30", "30 дней"], ["90", "90 дней"], ["365", "Год"], ["none", "Бессрочно"],
    ]);
    const access = screen.getByLabelText("Доступ");
    expect(access.id).toBe("tok-access");
    expect(access).toHaveValue("full");
    expect(access).toBeEnabled();
    expect([...access.querySelectorAll("option")].map((o) => [o.value, o.textContent])).toEqual([
      ["full", "Полный"], ["read", "Только чтение"], ["ci", "Только сигнал из CI"],
    ]);
    // «Закрыть» подвала (у крестика окна то же имя, но без текста).
    const close = screen.getAllByRole("button", { name: "Закрыть" }).find((b) => b.textContent === "Закрыть");
    if (!close) throw new Error("нет кнопки «Закрыть» в подвале");
    await userEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tokensApi.create).not.toHaveBeenCalled();
  });

  it("список не загрузился — ошибка видна, выпускать нельзя", async () => {
    vi.mocked(tokensApi.list).mockRejectedValue(new Error("Нет связи с сервером"));
    render(<AgentTokensDialog readOnlyOnly={false} onClose={vi.fn()} />);
    expect(await screen.findByText(/Нет связи с сервером/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выпустить токен" })).toBeDisabled();
  });
});
