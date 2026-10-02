// Страница входа: слева заголовок и анимированное превью схемы, справа форма
// «Логин / Пароль». Регистрации здесь нет: учётные записи заводит администратор.
// Вход как раньше: login → saveToken → onLogin; notice — причина, по которой
// сессию закрыли без спроса.
import { useState } from "react";
import { login, saveToken } from "../api/auth";
import LoginScenePreview from "../components/login/LoginScenePreview";
import BrandLink from "../ui/BrandLink";
import "./LoginPage.css";

interface Props {
  onLogin: () => void;
  // Почему сессию закрыли без спроса (например, «Учётная запись заблокирована»):
  // жёлтая плашка на месте ошибки входа, пока человек не попробует войти снова.
  notice?: string | null;
}

// Сообщение под полями: ошибка входа (красная) или причина выхода (жёлтая).
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
    <div className="login">
      <section className="login-left">
        <BrandLink />
        <div className="login-pitch">
          <h1>Документация, понятная вам и вашим агентам</h1>
          <p>Архитектура, логика и бизнес-процессы в одном месте.</p>
        </div>
        <div className="login-canvas">
          <LoginScenePreview />
        </div>
      </section>

      <main className="login-right">
        <div className="login-formbox">
          <h2>Вход</h2>
          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
              <label htmlFor="login-username">Логин</label>
              <div className="login-wrap">
                <input
                  id="login-username"
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
                  className={`login-input--password${badPassword ? " login-input--bad" : ""}`}
                  aria-invalid={badPassword || undefined}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="login-eye"
                  aria-label={showPassword ? "Скрыть пароль" : "Показать пароль"}
                  onClick={() => setShowPassword((v) => !v)}
                >
                  <EyeIcon />
                </button>
              </div>
            </div>
            {/* Слот сообщения есть всегда, даже пустой: его зазор в сетке формы
                отделяет кнопку от полей, как в принятом макете. */}
            <div>
              {message && (
                <div className={`login-msg login-msg--${message.kind}`} role="alert">
                  {message.text}
                </div>
              )}
            </div>
            <button type="submit" className="login-btn" disabled={busy}>
              {busy ? "Входим…" : "Войти"}
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
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
