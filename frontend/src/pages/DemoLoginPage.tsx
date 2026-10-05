// Вход в демо-стенд (docs/tasks/demo-mode.md, экран 1 прототипа): вместо формы
// «Логин / Пароль» — «Попробовать без регистрации» и «Установить» (репозиторий на
// GitHub). Левая половина та же, что у обычного входа (LoginPitch).
//
// Входа по логину на стенде нет: гость возвращается в свою песочницу, пока его
// браузер хранит сессию. notice — почему сессию закрыли без спроса (песочницу убрали
// после суток бездействия): жёлтая плашка, пока человек не попробует снова.
import { useState } from "react";
import { saveToken, startDemo } from "../api/auth";
import LoginPitch from "../components/login/LoginPitch";
import { GitHubIcon } from "../ui/icons";
import "./LoginPage.css";
import "./DemoLoginPage.css";

// Репозиторий опенсорс-версии: «Установить» ведёт туда в новой вкладке.
export const REPO_URL = "https://github.com/eidunyushkinhse/archmap";

interface Props {
  onLogin: () => void;
  notice?: string | null;
}

// Сообщение над фактами: отказ стенда (красное) или причина выхода (жёлтое).
type Message = { kind: "error" | "notice"; text: string };

export default function DemoLoginPage({ onLogin, notice = null }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(
    notice ? { kind: "notice", text: notice } : null,
  );

  async function handleStart() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const token = await startDemo();
      saveToken(token.access_token);
      onLogin();
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "Не удалось начать" });
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <LoginPitch />

      <main className="login-right">
        <div className="demo-box">
          <h2>Попробуйте ArchMap</h2>
          {message && (
            <div className={`login-msg login-msg--${message.kind}`} role="alert">
              {message.text}
            </div>
          )}
          <ul className="demo-facts">
            <li>Познакомьтесь с демо-проектом «Ярмарка». Вы поймёте, как может выглядеть ваша документация.</li>
            <li>Начните свой первый проект с нуля. Вы поймёте, как эта документация создаётся.</li>
          </ul>
          <div className="demo-actions">
            <button
              type="button"
              className="demo-btn demo-btn--primary"
              disabled={busy}
              onClick={() => void handleStart()}
            >
              {busy && <span className="demo-spin" aria-hidden />}
              {busy ? "Готовим песочницу…" : "Попробовать без регистрации"}
            </button>
            <a
              className="demo-btn demo-btn--secondary"
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <GitHubIcon />
              Установить
            </a>
          </div>
          <p className="demo-hint">
            Помните: это только знакомство. Ваш проект удалится через сутки бездействия. Не вносите
            сюда рабочие данные. Полные возможности ArchMap раскроются в вашем контуре.
          </p>
        </div>
      </main>
    </div>
  );
}
