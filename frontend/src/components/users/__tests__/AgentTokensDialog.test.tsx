// Окно «Токены для агентов»: секрет показывается один раз (потом в списке — только
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
    render(<AgentTokensDialog onClose={vi.fn()} />);
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
    render(<AgentTokensDialog onClose={onClose} />);
    // пустой список не печатается, сразу форма
    await waitFor(() => expect(tokensApi.list).toHaveBeenCalled());
    expect(screen.queryByText("Новый токен")).not.toBeInTheDocument();

    const name = screen.getByLabelText("Название");
    await userEvent.clear(name);
    await userEvent.type(name, "  Ноутбук ");
    await userEvent.click(screen.getByLabelText("Только чтение"));
    await userEvent.selectOptions(screen.getByLabelText("Срок действия"), "30");
    await userEvent.click(screen.getByRole("button", { name: "Выпустить токен" }));

    expect(tokensApi.create).toHaveBeenCalledWith({ name: "Ноутбук", read_only: true, lifetime_days: 30 });
    expect(await screen.findByText("Токен выпущен")).toBeInTheDocument();
    const url = `${window.location.origin}/mcp`;
    expect(screen.getByTestId("issued-secret")).toHaveTextContent(SECRET);
    expect(screen.getByTestId("issued-claude")).toHaveTextContent(
      `claude mcp add --transport http archmap ${url} --header "Authorization: Bearer ${SECRET}"`,
    );
    // Cursor — второй вкладкой
    expect(screen.queryByTestId("issued-cursor")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Cursor" }));
    expect(screen.getByRole("tab", { name: "Cursor" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("issued-claude")).not.toBeInTheDocument();
    const json = JSON.parse(screen.getByTestId("issued-cursor").textContent ?? "") as unknown;
    expect(json).toEqual({
      mcpServers: { archmap: { url, headers: { Authorization: `Bearer ${SECRET}` } } },
    });
    await userEvent.click(screen.getByRole("button", { name: "Готово" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("при следующем открытии секрета нет — только префикс", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([token({ name: "Ноутбук" })]);
    render(<AgentTokensDialog onClose={vi.fn()} />);
    expect(await screen.findByText("archmap_Zx9se…")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(SECRET))).not.toBeInTheDocument();
  });

  it("отказ бэка при выпуске виден под формой, окно остаётся", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([]);
    vi.mocked(tokensApi.create).mockRejectedValue(new Error("Токен с таким именем у вас уже есть"));
    render(<AgentTokensDialog onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Выпустить токен" }));
    expect(await screen.findByText("Токен с таким именем у вас уже есть")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выпустить токен" })).toBeEnabled();
  });

  it("пустое название — выпускать нечего", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([]);
    render(<AgentTokensDialog onClose={vi.fn()} />);
    await userEvent.clear(await screen.findByLabelText("Название"));
    expect(screen.getByRole("button", { name: "Выпустить токен" })).toBeDisabled();
  });

  it("отзыв — через подтверждение; «Отмена» ничего не шлёт", async () => {
    vi.mocked(tokensApi.list).mockResolvedValue([token(), token({ id: "t-2", name: "Ноутбук" })]);
    vi.mocked(tokensApi.revoke).mockResolvedValue(undefined);
    render(<AgentTokensDialog onClose={vi.fn()} />);

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
    render(<AgentTokensDialog onClose={vi.fn()} />);
    await userEvent.click(await screen.findByRole("button", { name: "Отозвать Агент" }));
    await userEvent.click(screen.getByRole("button", { name: "Отозвать" }));
    expect(await screen.findByText("Нет связи с сервером")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Отозвать" })).toBeEnabled();
    expect(screen.getByTestId("token-Агент")).toBeInTheDocument();
  });

  it("список не загрузился — ошибка видна, выпускать нельзя", async () => {
    vi.mocked(tokensApi.list).mockRejectedValue(new Error("Нет связи с сервером"));
    render(<AgentTokensDialog onClose={vi.fn()} />);
    expect(await screen.findByText(/Нет связи с сервером/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Выпустить токен" })).toBeDisabled();
  });
});
