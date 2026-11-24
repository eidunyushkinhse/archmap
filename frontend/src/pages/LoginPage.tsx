// Страница входа: слева заголовок и анимированное превью схемы, справа форма
// «Логин / Пароль». Регистрации здесь нет: учётные записи заводит администратор.
// Вход как раньше: login → saveToken → onLogin; notice — причина, по которой
// сессию закрыли без спроса. Вид (редизайн, фаза 12б): поля, кнопка показа пароля и
// главная кнопка — примитивы нового языка (ui/ds.css), сообщение — абзацем без коробки.
import { useState } from "react";
import { login, saveToken } from "../api/auth";
import LoginPitch from "../components/login/LoginPitch";
import "../ui/ds.css";
import "./LoginPage.css";

interface Props {
  onLogin: () => void;
  // Почему сессию закрыли без спроса (например, «Учётная запись заблокирована»):
  // предупреждение на месте ошибки входа, пока человек не попробует войти снова.
  notice?: string | null;
}

// Сообщение над кнопкой: отказ входа (цветом опасности) или причина выхода (предупреждение).
type Message = { kind: "error" | "notice"; text: string };

export default function LoginPage({ onLogin, notice = null }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(
    notice ? { kind: "notice", text: notice } : null,
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const token = await login(username, password);
      saveToken(token.access_token);
      onLogin();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Ошибка входа" });
      setBusy(false);
    }
  }

  const badPassword = message?.kind === "error";

  return (
    <div className="login ds">
      <LoginPitch />

      <main className="login-right">
        <div className="login-formbox">
          <h2>Вход</h2>
          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
              <label htmlFor="login-username">Логин</label>
              <div className="login-wrap">
                <input
                  id="login-username"
                  className="ds-input"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
            </div>
            <div className="login-field">
              <label htmlFor="login-password">Пароль</label>
              <div className="login-wrap">
                <input
                  id="login-password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  className={`ds-input login-input--password${badPassword ? " login-input--bad" : ""}`}
                  aria-invalid={badPassword || undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="ds-icon-btn login-eye"
                  aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  <EyeIcon />
                </button>
              </div>
            </div>
            {message && (
              <p className={`${message.kind === "error" ? "ds-danger" : "ds-warn"} login-msg`} role="alert">
                {message.text}
              </p>
            )}
            <button type="submit" className="ds-btn ds-btn--primary login-submit" disabled={busy}>
              {busy ? "Входим" : "Войти"}
            </button>
          </form>
          <div className="login-hint">Нет учётной записи? Попросите администратора её завести.</div>
        </div>
      </main>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
