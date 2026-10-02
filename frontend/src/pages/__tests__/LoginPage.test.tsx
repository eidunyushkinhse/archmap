// Страница входа: поля и кнопка, ошибка сервера и notice в плашках, глаз пароля,
// неактивная кнопка во время запроса, onLogin после успешного входа.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import LoginPage from "../LoginPage";
import { login, saveToken } from "../../api/auth";
import type { Token } from "../../types";

vi.mock("../../api/auth", () => ({ login: vi.fn(), saveToken: vi.fn() }));
// Превью схемы — картинка со своим циклом анимации и своими тестами; здесь не нужно.
vi.mock("../../components/login/LoginScenePreview", () => ({
  default: () => <svg role="img" aria-label="превью схемы" />,
}));

const TOKEN: Token = { access_token: "tok-1", token_type: "bearer" };

async function fillAndSubmit(username = "m.orlova", password = "secret-pass") {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Логин"), username);
  await user.type(screen.getByLabelText("Пароль"), password);
  await user.click(screen.getByRole("button", { name: "Войти" }));
  return user;
}

describe("LoginPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("заголовок, поля, кнопка и подсказка на месте; регистрации нет", () => {
    render(<LoginPage onLogin={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Документация, понятная вам и вашим агентам" })).toBeInTheDocument();
    expect(screen.getByText("Архитектура, логика и бизнес-процессы в одном месте.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "превью схемы" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Вход" })).toBeInTheDocument();
    expect(screen.getByLabelText("Логин")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Пароль")).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Показать пароль" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Войти" })).toBeEnabled();
    expect(screen.getByText("Нет учётной записи? Попросите администратора её завести.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/регистрац/i)).toBeNull();
  });

  it("неверный вход: красная плашка с текстом сервера, красная рамка пароля", async () => {
    vi.mocked(login).mockRejectedValue(new Error("Неверный логин или пароль"));
    const onLogin = vi.fn();
    render(<LoginPage onLogin={onLogin} />);
    await fillAndSubmit("ivan", "wrong");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Неверный логин или пароль");
    expect(alert).toHaveClass("login-msg--error");
    expect(screen.getByLabelText("Пароль")).toHaveClass("login-input--bad");
    expect(screen.getByLabelText("Пароль")).toHaveAttribute("aria-invalid", "true");
    expect(login).toHaveBeenCalledWith("ivan", "wrong");
    expect(saveToken).not.toHaveBeenCalled();
    expect(onLogin).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Войти" })).toBeEnabled();
  });

  it("не-Error из login — общий текст «Ошибка входа»", async () => {
    vi.mocked(login).mockRejectedValue("сбой");
    render(<LoginPage onLogin={vi.fn()} />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Ошибка входа");
  });

  it("notice — жёлтая плашка; после новой попытки сменяется результатом", async () => {
    vi.mocked(login).mockRejectedValue(new Error("Неверный логин или пароль"));
    render(<LoginPage onLogin={vi.fn()} notice="Учётная запись заблокирована" />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Учётная запись заблокирована");
    expect(alert).toHaveClass("login-msg--notice");
    expect(screen.getByLabelText("Пароль")).not.toHaveClass("login-input--bad");

    await fillAndSubmit();
    const after = await screen.findByText("Неверный логин или пароль");
    expect(after).toHaveClass("login-msg--error");
    expect(screen.queryByText("Учётная запись заблокирована")).toBeNull();
  });

  it("глаз переключает тип поля пароля и подпись кнопки", async () => {
    const user = userEvent.setup();
    render(<LoginPage onLogin={vi.fn()} />);
    const password = screen.getByLabelText("Пароль");
    await user.click(screen.getByRole("button", { name: "Показать пароль" }));
    expect(password).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Скрыть пароль" }));
    expect(password).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "Показать пароль" })).toBeInTheDocument();
  });

  it("во время запроса кнопка неактивна и пишет «Входим…»", async () => {
    let resolve: (t: Token) => void = () => {};
    vi.mocked(login).mockImplementation(() => new Promise<Token>((r) => { resolve = r; }));
    const onLogin = vi.fn();
    render(<LoginPage onLogin={onLogin} />);
    const user = await fillAndSubmit();
    const busy = screen.getByRole("button", { name: "Входим…" });
    expect(busy).toBeDisabled();
    await user.click(busy); // повторный клик по неактивной кнопке запроса не шлёт
    expect(login).toHaveBeenCalledTimes(1);
    resolve(TOKEN);
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
  });

  it("успешный вход: токен сохранён, onLogin вызван", async () => {
    vi.mocked(login).mockResolvedValue(TOKEN);
    const onLogin = vi.fn();
    render(<LoginPage onLogin={onLogin} />);
    await fillAndSubmit("m.orlova", "secret-pass");
    await vi.waitFor(() => expect(onLogin).toHaveBeenCalledTimes(1));
    expect(login).toHaveBeenCalledWith("m.orlova", "secret-pass");
    expect(saveToken).toHaveBeenCalledWith("tok-1");
    expect(vi.mocked(saveToken).mock.invocationCallOrder[0])
      .toBeLessThan(onLogin.mock.invocationCallOrder[0]);
  });
});
