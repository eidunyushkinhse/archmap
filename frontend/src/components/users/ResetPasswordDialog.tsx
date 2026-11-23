import { useState } from "react";
import { adminApi } from "../../api/admin";
import type { AdminUser } from "../../types";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { useBusyAction } from "../../ui/useBusyAction";
import { PASSWORD_HINT } from "./userLabels";
import "../../ui/ds.css";
import "./userDialogs.css";

/**
 * «Сбросить пароль» (только администратор): новый пароль задаёт он сам и передаёт
 * человеку. Поле открытое по той же причине, что в «Новом пользователе».
 *
 * Вид (редизайн, фаза 9д): каркас окна нового языка (ui/ds.css, ds-win), пояснение первым
 * абзацем тела, строка «Новый пароль» с полем в рамке и тихая подсказка под ней
 * (users/userDialogs.css).
 */

interface Props {
  user: AdminUser;
  onClose: () => void;
  onDone: () => void;
}

export default function ResetPasswordDialog({ user, onClose, onDone }: Props) {
  const [password, setPassword] = useState("");
  const { busy, error, run } = useBusyAction("Не удалось сбросить пароль");

  const canSubmit = password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    await run(() => adminApi.resetPassword(user.id, password).then(onDone));
  }

  return (
    <Modal onClose={onClose} onSubmit={submit} boxStyle={{ width: 440, padding: 0 }}>
      <div className="ds ds-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">Сбросить пароль</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <p className="ud-lead">
            Новый пароль для «{user.username}». Передайте его человеку сами. Все активные сессии пользователя будут завершены.
          </p>
          <dl className="ds-props ud-props">
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor="rp-password">Новый пароль</label></dt>
              <dd className="ds-prop-value">
                <input
                  id="rp-password"
                  className="ds-input"
                  data-autofocus
                  autoComplete="off"
                  spellCheck={false}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </dd>
            </div>
          </dl>
          <p className="ud-hint">{PASSWORD_HINT}</p>
        </div>

        <div className="ds-win-foot">
          {error && <p className="ds-danger ds-win-err" role="alert">{error}</p>}
          <button type="button" className="ds-btn ds-btn--primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Сохраняем" : "Сбросить"}
          </button>
          <button type="button" className="ds-btn" disabled={busy} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}
