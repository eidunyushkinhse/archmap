import { useState } from "react";
import type { CSSProperties } from "react";
import { changePassword } from "../../api/auth";
import Modal from "../../ui/Modal";
import { input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const mismatch = repeat.length > 0 && repeat !== newPassword;
  const canSubmit = oldPassword.length > 0 && newPassword.length > 0 && repeat === newPassword && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(oldPassword, newPassword);
      setDone(true);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось сменить пароль");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Modal onClose={onClose} boxStyle={{ width: 400, padding: 24 }}>
        <h3 style={title}>Пароль изменён</h3>
        <p style={lead}>Со следующего входа действует новый пароль.</p>
        <button data-autofocus style={primaryBtn} onClick={onClose}>Готово</button>
      </Modal>
    );
  }

  const onEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") void submit(); };

  return (
    <Modal onClose={onClose} boxStyle={{ width: 400, padding: 24 }}>
      <h3 style={title}>Сменить пароль</h3>

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

const title: CSSProperties = { margin: "0 0 16px", fontSize: 18, fontWeight: 700, color: "#0f172a" };
const lead: CSSProperties = { margin: "0 0 16px", fontSize: 14, color: "#475569", lineHeight: 1.5 };
const hint: CSSProperties = { margin: "-4px 0 0", fontSize: 12.5, color: "#94a3b8" };
const errText: CSSProperties = { color: "#dc2626", fontSize: 13, margin: "8px 0 0" };
