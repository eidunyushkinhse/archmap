// Вход в демо-стенд (docs/tasks/demo-mode.md, экран 1 прототипа): вместо формы
// «Логин / Пароль» — «Попробовать без регистрации» и «Установить» (репозиторий на
// GitHub). Левая половина та же, что у обычного входа (LoginPitch). Вид (редизайн,
// фаза 12б): кнопки — примитивы нового языка (ui/ds.css), сообщение — абзацем без коробки.
//
// Входа по логину на стенде нет: гость возвращается в свою песочницу, пока его
// браузер хранит сессию. notice — почему сессию закрыли без спроса (песочницу убрали
// после суток бездействия): предупреждение, пока человек не попробует снова.
import { useState } from "react";
import { saveToken, startDemo } from "../api/auth";
import LoginPitch from "../components/login/LoginPitch";
import { GitHubIcon } from "../ui/icons";
import "../ui/ds.css";
import "./LoginPage.css";
import "./DemoLoginPage.css";

// Репозиторий опенсорс-версии: «Установить» ведёт туда в новой вкладке.
export const REPO_URL = "https://github.com/eidunyushkinhse/archmap";

interface Props {
  onLogin: () => void;
  notice?: string | null;
}

// Сообщение над пунктами: отказ стенда (цветом опасности) или причина выхода (предупреждение).
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
    <div className="login ds">
      <LoginPitch />

      <main className="login-right">
        <div className="demo-box">
          <h2>Попробуйте ArchMap</h2>
          {message && (
            <p className={`${message.kind === "error" ? "ds-danger" : "ds-warn"} login-msg`} role="alert">
              {message.text}
            </p>
          )}
          <ul className="demo-facts">
            <li>Познакомьтесь с демо-проектом «Ярмарка». Вы поймёте, как может выглядеть ваша документация.</li>
            <li>Начните свой первый проект с нуля. Вы поймёте, как эта документация создаётся.</li>
          </ul>
          <div className="demo-actions">
            <button
              type="button"
              className="ds-btn ds-btn--primary demo-btn"
              disabled={busy}
              onClick={() => void handleStart()}
            >
              {busy && <span className="demo-spin" aria-hidden />}
              {busy ? "Готовим песочницу" : "Попробовать без регистрации"}
            </button>
            <a
              className="ds-btn demo-btn"
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <GitHubIcon />
              Установить
            </a>
          </div>
          <p className="demo-hint">
            Это только знакомство. Ваш проект удалится, если сутки в нём ничего не делать. Не
            вносите сюда рабочие данные. Все возможности ArchMap откроются, когда вы установите
            его у себя.
          </p>
        </div>
      </main>
    </div>
  );
}
