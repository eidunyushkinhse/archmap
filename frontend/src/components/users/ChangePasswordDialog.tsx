import { useState } from "react";
import type { CSSProperties } from "react";
import { changePassword } from "../../api/auth";
import DialogTitle from "../../ui/DialogTitle";
import Modal from "../../ui/Modal";
import { errText, input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";
import { useBusyAction } from "../../ui/useBusyAction";

/**
 * «Сменить пароль» из меню профиля (у всех): текущий пароль, новый и повтор.
 * Совпадение повтора проверяется здесь (на сервер уходит один новый пароль);
 * длину и верность текущего проверяет бэк — его текст ошибки показывается как есть.
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

  if (done) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 400, padding: 24 }}>
        <DialogTitle lead="Со следующего входа действует новый пароль.">Пароль изменён</DialogTitle>
        <button data-autofocus style={primaryBtn} onClick={onClose}>Готово</button>
      </Modal>
    );
  }

  const onEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") void submit(); };

  return (
    <Modal onClose={onClose} boxStyle={{ width: 400, padding: 24 }}>
      <DialogTitle>Сменить пароль</DialogTitle>

      <label style={labelStyle} htmlFor="cp-old">Текущий пароль</label>
      <input
        id="cp-old"
        data-autofocus
        type="password"
        autoComplete="current-password"
        style={input}
        value={oldPassword}
        onChange={(e) => setOldPassword(e.target.value)}
        onKeyDown={onEnter}
      />

      <label style={labelStyle} htmlFor="cp-new">Новый пароль</label>
      <input
        id="cp-new"
        type="password"
        autoComplete="new-password"
        style={input}
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        onKeyDown={onEnter}
      />

      <label style={labelStyle} htmlFor="cp-repeat">Повторите новый пароль</label>
      <input
        id="cp-repeat"
        type="password"
        autoComplete="new-password"
        style={input}
        value={repeat}
        onChange={(e) => setRepeat(e.target.value)}
        onKeyDown={onEnter}
      />
      <p style={hint}>Не короче 8 символов</p>

      {mismatch && <p style={errText}>Пароли не совпадают</p>}
      {error && <p style={errText}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button style={{ ...primaryBtn, opacity: canSubmit ? 1 : 0.55 }} disabled={!canSubmit} onClick={submit}>
          {busy ? "Сохранение…" : "Сменить"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

const hint: CSSProperties = { margin: "-4px 0 0", fontSize: 12.5, color: "#94a3b8" };
