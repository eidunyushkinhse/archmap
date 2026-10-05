// Демо-вход (docs/tasks/demo-mode.md, экран 1 прототипа): все четыре состояния —
// обычное, «Готовим песочницу…», «слишком много пользователей», «песочница удалена».
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import DemoLoginPage, { REPO_URL } from "../DemoLoginPage";
import { saveToken, startDemo } from "../../api/auth";
import { ApiError, SANDBOX_GONE_DETAIL } from "../../api/client";
import type { Token } from "../../types";

vi.mock("../../api/auth", () => ({ startDemo: vi.fn(), saveToken: vi.fn() }));
vi.mock("../../components/login/LoginScenePreview", () => ({
  default: () => <svg role="img" aria-label="превью схемы" />,
}));

const TOKEN: Token = { access_token: "guest-tok", token_type: "bearer" };
const FULL = "На демо сейчас слишком много пользователей. Попробуйте через час.";

describe("DemoLoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("обычное: левая половина как у входа, справа кнопки и подсказка, формы логина нет", () => {
    render(<DemoLoginPage onLogin={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Документация, понятная вам и вашим агентам" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "превью схемы" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Попробуйте ArchMap" })).toBeInTheDocument();
    expect(screen.getByText(
      "Познакомьтесь с демо-проектом «Ярмарка». Вы поймёте, как может выглядеть ваша документация.",
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Начните свой первый проект с нуля. Вы поймёте, как эта документация создаётся.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Попробовать без регистрации" })).toBeEnabled();
    const install = screen.getByRole("link", { name: "Установить" });
    expect(install).toHaveAttribute("href", REPO_URL);
    expect(REPO_URL).toBe("https://github.com/eidunyushkinhse/archmap");
    expect(install).toHaveAttribute("target", "_blank");
    expect(install.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(
      "Помните: это только знакомство. Ваш проект удалится через сутки бездействия. Не вносите "
      + "сюда рабочие данные. Полные возможности ArchMap раскроются в вашем контуре.",
    )).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText("Логин")).toBeNull();
    expect(screen.queryByLabelText("Пароль")).toBeNull();
  });

  it("старт: кнопка гаснет с «Готовим песочницу…», потом токен и вход", async () => {
    let finish: (t: Token) => void = () => {};
    vi.mocked(startDemo).mockReturnValue(new Promise<Token>((r) => { finish = r; }));
    const onLogin = vi.fn();
    render(<DemoLoginPage onLogin={onLogin} />);
    await userEvent.click(screen.getByRole("button", { name: "Попробовать без регистрации" }));
    const busy = screen.getByRole("button", { name: "Готовим песочницу…" });
    expect(busy).toBeDisabled();
    finish(TOKEN);
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
    expect(saveToken).toHaveBeenCalledWith("guest-tok");
  });

  it("стенд полон: красная плашка с текстом сервера, кнопка снова доступна", async () => {
    vi.mocked(startDemo).mockRejectedValue(new ApiError(429, FULL));
    const onLogin = vi.fn();
    render(<DemoLoginPage onLogin={onLogin} />);
    await userEvent.click(screen.getByRole("button", { name: "Попробовать без регистрации" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(FULL);
    expect(alert).toHaveClass("login-msg--error");
    expect(screen.getByRole("button", { name: "Попробовать без регистрации" })).toBeEnabled();
    expect(onLogin).not.toHaveBeenCalled();
    expect(saveToken).not.toHaveBeenCalled();
  });

  it("песочница удалена: жёлтая плашка, новая попытка её убирает", async () => {
    vi.mocked(startDemo).mockResolvedValue(TOKEN);
    render(<DemoLoginPage onLogin={vi.fn()} notice={SANDBOX_GONE_DETAIL} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Ваша песочница удалена: прошли сутки бездействия. Начните заново, это займёт пару секунд.",
    );
    expect(alert).toHaveClass("login-msg--notice");
    await userEvent.click(screen.getByRole("button", { name: "Попробовать без регистрации" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
