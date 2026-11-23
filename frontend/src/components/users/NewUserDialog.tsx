import { useState } from "react";
import { adminApi } from "../../api/admin";
import type { AdminUser, UserRole } from "../../types";
import Modal from "../../ui/Modal";
import { ChevronDownIcon, CloseIcon } from "../../ui/icons";
import { useBusyAction } from "../../ui/useBusyAction";
import { PASSWORD_HINT, ROLE_LABEL, ROLES } from "./userLabels";
import "../../ui/ds.css";
import "./userDialogs.css";

/**
 * «Новый пользователь» (только администратор): логин, роль, признак администратора
 * и временный пароль. Почты нет — пароль администратор передаёт человеку сам,
 * поэтому поле открытое: его надо видеть, чтобы продиктовать или скопировать.
 *
 * Вид (редизайн, фаза 9д): каркас окна нового языка (ui/ds.css, ds-win), строки «тихая
 * подпись — поле в рамке» (users/userDialogs.css), флажок «Администратор» в колонке
 * значений с подписью строки. «Создать» заперта, пока нет логина и пароля.
 */

interface Props {
  onClose: () => void;
  onCreated: (user: AdminUser) => void;
}

export default function NewUserDialog({ onClose, onCreated }: Props) {
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<UserRole>("viewer");
  const [isAdmin, setIsAdmin] = useState(false);
  const [password, setPassword] = useState("");
  const { busy, error, run } = useBusyAction("Не удалось создать пользователя");

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  // Администратор всегда архитектор — полные права (правило держит бэк).
  const shownRole: UserRole = isAdmin ? "architect" : role;

  async function submit() {
    if (!canSubmit) return;
    await run(() => adminApi.create({ username: username.trim(), role: shownRole, is_admin: isAdmin, password }).then(onCreated));
  }

  return (
    <Modal onClose={onClose} onSubmit={submit} boxStyle={{ width: 440, padding: 0 }}>
      <div className="ds ds-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">Новый пользователь</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <dl className="ds-props ud-props">
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor="nu-login">Логин</label></dt>
              <dd className="ds-prop-value">
                <input
                  id="nu-login"
                  className="ds-input"
                  data-autofocus
                  autoComplete="off"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                />
              </dd>
            </div>
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor="nu-role">Роль</label></dt>
              <dd className="ds-prop-value">
                <span className="ds-select">
                  <select
                    id="nu-role"
                    value={shownRole}
                    disabled={isAdmin}
                    onChange={(e) => setRole(e.target.value as UserRole)}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                  <ChevronDownIcon />
                </span>
              </dd>
            </div>
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor="nu-admin">Администратор</label></dt>
              <dd className="ds-prop-value">
                <span className="ds-check">
                  <input id="nu-admin" type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
                </span>
              </dd>
            </div>
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor="nu-password">Временный пароль</label></dt>
              <dd className="ds-prop-value">
                <input
                  id="nu-password"
                  className="ds-input"
                  autoComplete="off"
                  spellCheck={false}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </dd>
            </div>
          </dl>
          <p className="ud-hint">{PASSWORD_HINT}. Передайте пароль человеку сами, сменить его можно в меню профиля.</p>
        </div>

        <div className="ds-win-foot">
          {error && <p className="ds-danger ds-win-err" role="alert">{error}</p>}
          <button type="button" className="ds-btn ds-btn--primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Создаём" : "Создать"}
          </button>
          <button type="button" className="ds-btn" disabled={busy} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}
