// Вид «Токен выпущен» окна «Токены для MCP»: секрет один раз, вкладки клиентов или CI,
// что уходит в буфер по каждой «Скопировать» и что видно, когда браузер не дал скопировать.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";
import IssuedTokenView from "../IssuedTokenView";
import { ciSnippet } from "../ciSignal";
import { CopyFailed, copyText } from "../../../lib/copyText";
import type { PersonalToken } from "../../../types";

vi.mock("../../../lib/copyText", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/copyText")>()),
  copyText: vi.fn(),
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

const copyButtons = () => screen.getAllByRole("button").filter((b) => /^Скопир/.test(b.textContent ?? ""));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(copyText).mockResolvedValue(undefined);
});

describe("IssuedTokenView", () => {
  it("агент: секрет и пояснение, вкладки CLI и Desktop, пояснения вкладок", async () => {
    render(<IssuedTokenView issued={{ token: token(), secret: SECRET }} onDone={vi.fn()} />);
    expect(screen.getByText("Токен выпущен")).toBeInTheDocument();
    expect(screen.getByText("Токен будет показан только один раз. Скопируйте его сейчас.")).toBeInTheDocument();
    expect(screen.getByTestId("issued-secret")).toHaveTextContent(SECRET);
    expect(screen.getByText("Подключение")).toBeInTheDocument();
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-label", "Клиент");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => [t.textContent, t.getAttribute("aria-selected")])).toEqual([
      ["CLI", "true"], ["Desktop", "false"],
    ]);
    expect(screen.getByText("Вместо <cli> подставьте свою программу, например claude, qwen или gigacode")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Desktop" }));
    expect(screen.getByRole("tab", { name: "Desktop" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "CLI" })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("В файл настроек MCP приложения")).toBeInTheDocument();
  });

  it("«Скопировать»: секрет как есть, команда CLI и блок Desktop целиком; надпись у нажатой", async () => {
    render(<IssuedTokenView issued={{ token: token(), secret: SECRET }} onDone={vi.fn()} />);
    const url = `${window.location.origin}/mcp`;
    const [secretBtn, blockBtn] = copyButtons();
    await userEvent.click(secretBtn);
    expect(copyText).toHaveBeenLastCalledWith(SECRET);
    expect(secretBtn).toHaveTextContent("Скопировано");
    expect(blockBtn).toHaveTextContent("Скопировать");

    await userEvent.click(blockBtn);
    expect(copyText).toHaveBeenLastCalledWith(
      `<cli> mcp add --transport http archmap ${url} --header "Authorization: Bearer ${SECRET}"`,
    );
    expect(blockBtn).toHaveTextContent("Скопировано");
    expect(secretBtn).toHaveTextContent("Скопировать");

    await userEvent.click(screen.getByRole("tab", { name: "Desktop" }));
    await userEvent.click(copyButtons()[1]);
    expect(copyText).toHaveBeenLastCalledWith(JSON.stringify(
      { mcpServers: { archmap: { url, headers: { Authorization: `Bearer ${SECRET}` } } } },
      null,
      2,
    ));
  });

  it("браузер не дал скопировать — подсказка скопировать вручную, надпись кнопки прежняя", async () => {
    vi.mocked(copyText).mockRejectedValue(new CopyFailed(SECRET));
    render(<IssuedTokenView issued={{ token: token(), secret: SECRET }} onDone={vi.fn()} />);
    const [secretBtn] = copyButtons();
    await userEvent.click(secretBtn);
    expect(await screen.findByText("Браузер не дал скопировать. Выделите текст и скопируйте вручную.")).toBeInTheDocument();
    expect(secretBtn).toHaveTextContent("Скопировать");
    // Удачное копирование убирает подсказку.
    vi.mocked(copyText).mockResolvedValue(undefined);
    await userEvent.click(secretBtn);
    expect(screen.queryByText("Браузер не дал скопировать. Выделите текст и скопируйте вручную.")).not.toBeInTheDocument();
    expect(secretBtn).toHaveTextContent("Скопировано");
  });

  it("токен CI: заголовок сигнала, вкладки GitLab, GitHub и curl; копируется строка вкладки", async () => {
    render(<IssuedTokenView issued={{ token: token({ name: "CI", ci_only: true }), secret: SECRET }} onDone={vi.fn()} />);
    expect(screen.getByText("Сигнал из CI после слияния в main")).toBeInTheDocument();
    expect(screen.getByRole("tablist")).toHaveAttribute("aria-label", "CI");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["GitLab", "GitHub", "curl"]);
    expect(screen.getByText("Задание в .gitlab-ci.yml, токен в переменной ARCHMAP_TOKEN")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "curl" }));
    expect(screen.getByRole("tab", { name: "curl" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Для другого CI: подставьте адрес репозитория, коммит и ветку")).toBeInTheDocument();
    expect(screen.getByTestId("issued-curl").textContent).toBe(ciSnippet("curl", window.location.origin));
    await userEvent.click(copyButtons()[1]);
    expect(copyText).toHaveBeenLastCalledWith(ciSnippet("curl", window.location.origin));
  });

  it("«Готово» в фокусе по умолчанию и закрывает окно", async () => {
    const onDone = vi.fn();
    render(<IssuedTokenView issued={{ token: token(), secret: SECRET }} onDone={onDone} />);
    const done = screen.getByRole("button", { name: "Готово" });
    expect(done).toHaveAttribute("data-autofocus");
    await userEvent.click(done);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

// Вид (редизайн, фаза 9д): каркас окна нового языка, блоки кода, вкладки-текст ds-tabs.
describe("вид «Токен выпущен»", () => {
  it("каркас, блоки кода, вкладки нового языка, кнопки ds-btn; инлайн-стилей нет", async () => {
    render(<IssuedTokenView issued={{ token: token(), secret: SECRET }} onDone={vi.fn()} />);
    expect(screen.getByRole("heading", { level: 2, name: "Токен выпущен" })).toHaveClass("ds-win-title");
    expect(screen.getByRole("button", { name: "Закрыть" })).toHaveClass("ds-win-close");
    const body = document.querySelector(".ds-win-body");
    expect(body?.firstElementChild).toHaveTextContent("Токен будет показан только один раз. Скопируйте его сейчас.");
    expect(screen.getByTestId("issued-secret")).toHaveClass("ud-code");
    expect(screen.getByTestId("issued-cli")).toHaveClass("ud-code");
    expect(screen.getByText("Подключение").tagName).toBe("H3");
    expect(screen.getByText("Подключение")).toHaveClass("ds-win-block-title");
    expect(screen.getByRole("tablist")).toHaveClass("ds-tabs");
    expect(screen.getByRole("tab", { name: "CLI" })).toHaveClass("ds-tab", "is-active");
    expect(screen.getByRole("tab", { name: "Desktop" })).toHaveClass("ds-tab");
    expect(screen.getByRole("tab", { name: "Desktop" })).not.toHaveClass("is-active");
    // Заглушка имени программы — отдельным тихим словом в начале команды.
    expect(screen.getByTestId("issued-cli").querySelector(".ud-stub")).toHaveTextContent("<cli>");
    for (const b of copyButtons()) expect(b.className).toBe("ds-btn");
    expect(screen.getByRole("button", { name: "Готово" }).className).toBe("ds-btn ds-btn--primary");
    expect(document.querySelectorAll(".ds-win [style]")).toHaveLength(0);
  });

  // Находка 8 (2026-11-24): строка CLI и длинные строки задания CI уходили за край блока и
  // читались только прокруткой вбок. jsdom раскладку не считает: правило читаем текстом, а
  // что «Скопировать» берёт исходный текст без переносов, проверяем по буферу.
  it("длинные строки блока переносятся внутри него, копируется исходный текст", async () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "userDialogs.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const pre = css.split("}").find((chunk) => chunk.split("{")[0].trim() === ".ud-pre")?.split("{")[1] ?? "";
    expect(pre).toContain("white-space: pre-wrap");
    expect(pre).toContain("overflow-wrap: anywhere");
    expect(pre).not.toContain("overflow-x");

    render(<IssuedTokenView issued={{ token: token({ name: "CI", ci_only: true }), secret: SECRET }} onDone={vi.fn()} />);
    const gitlab = ciSnippet("gitlab", window.location.origin);
    expect(screen.getByTestId("issued-gitlab")).toHaveClass("ud-pre");
    expect(screen.getByTestId("issued-gitlab").textContent).toBe(gitlab);
    await userEvent.click(copyButtons()[1]);
    expect(copyText).toHaveBeenLastCalledWith(gitlab);
  });

  it("отказ буфера — строкой предупреждения ds-warn", async () => {
    vi.mocked(copyText).mockRejectedValue(new CopyFailed(SECRET));
    render(<IssuedTokenView issued={{ token: token(), secret: SECRET }} onDone={vi.fn()} />);
    await userEvent.click(copyButtons()[0]);
    expect(await screen.findByText("Браузер не дал скопировать. Выделите текст и скопируйте вручную.")).toHaveClass("ds-warn");
  });
});
