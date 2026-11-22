import { useState } from "react";
import { changePassword } from "../../api/auth";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { useBusyAction } from "../../ui/useBusyAction";
import "../../ui/ds.css";
import "./userDialogs.css";

/**
 * «Сменить пароль» из меню профиля (у всех): текущий пароль, новый и повтор.
 * Совпадение повтора проверяется здесь (на сервер уходит один новый пароль);
 * длину и верность текущего проверяет бэк — его текст ошибки показывается как есть.
 *
 * Вид (редизайн, фаза 9д): каркас окна нового языка (ui/ds.css, ds-win), строки «тихая
 * подпись — поле в рамке» (users/userDialogs.css); колонка подписей шире общей, чтобы
 * «Повторите новый пароль» стояла в одну строку. Порядок полей, id и autoComplete
 * прежние: на них опираются менеджеры паролей.
 */

interface Props {
  onClose: () => void;
}

export default function ChangePasswordDialog({ onClose }: Props) {
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const { busy, error, run } = useBusyAction("Не удалось сменить пароль");
  const [done, setDone] = useState(false);

  const mismatch = repeat.length > 0 && repeat !== newPassword;
  const canSubmit = oldPassword.length > 0 && newPassword.length > 0 && repeat === newPassword && !busy;

  async function submit() {
    if (!canSubmit) return;
    // Успех сменяет вид окна на «Пароль изменён» — занятость формы там уже не видна.
    await run(() => changePassword(oldPassword, newPassword).then(() => setDone(true)));
  }

  const head = (title: string) => (
    <div className="ds-win-head">
      <h2 className="ds-win-title">{title}</h2>
      <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
        <CloseIcon />
      </button>
    </div>
  );

  if (done) {
    return (
      <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 440, padding: 0 }}>
        <div className="ds ds-win">
          {head("Пароль изменён")}
          <div className="ds-win-body">
            <p className="ud-lead">Остальные активные сессии завершены.</p>
          </div>
          <div className="ds-win-foot">
            <button type="button" data-autofocus className="ds-btn ds-btn--primary" onClick={onClose}>Готово</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} onSubmit={submit} closeButton={false} boxStyle={{ width: 440, padding: 0 }}>
      <div className="ds ds-win">
        {head("Сменить пароль")}

        <div className="ds-win-body">
          <dl className="ds-props ud-props ud-props--wide">
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor="cp-old">Текущий пароль</label></dt>
              <dd className="ds-prop-value">
                <input
                  id="cp-old"
                  className="ds-input"
                  data-autofocus
                  type="password"
                  autoComplete="current-password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                />
              </dd>
            </div>
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor="cp-new">Новый пароль</label></dt>
              <dd className="ds-prop-value">
                <input
                  id="cp-new"
                  className="ds-input"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </dd>
            </div>
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor="cp-repeat">Повторите новый пароль</label></dt>
              <dd className="ds-prop-value">
                <input
                  id="cp-repeat"
                  className="ds-input"
                  type="password"
                  autoComplete="new-password"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value)}
                />
              </dd>
            </div>
          </dl>
          <p className="ud-hint">Не короче 8 символов</p>
          {mismatch && <p className="ds-danger ud-flat">Пароли не совпадают</p>}
        </div>

        <div className="ds-win-foot">
          {error && <p className="ds-danger ds-win-err" role="alert">{error}</p>}
          <button type="button" className="ds-btn ds-btn--primary" disabled={!canSubmit} onClick={() => void submit()}>
            {busy ? "Сохраняем" : "Сменить"}
          </button>
          <button type="button" className="ds-btn" disabled={busy} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}
