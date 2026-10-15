import { useState } from "react";
import type { CSSProperties } from "react";
import { adminApi } from "../../api/admin";
import type { AdminUser } from "../../types";
import DialogTitle from "../../ui/DialogTitle";
import Modal from "../../ui/Modal";
import { errText, input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";
import { useBusyAction } from "../../ui/useBusyAction";
import { PASSWORD_HINT } from "./userLabels";

/**
 * «Сбросить пароль» (только администратор): новый пароль задаёт он сам и передаёт
 * человеку. Поле открытое по той же причине, что в «Новом пользователе».
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
    <Modal onClose={onClose} boxStyle={{ width: 400, padding: 24 }}>
      <DialogTitle lead={<>Новый пароль для «{user.username}». Передайте его человеку сами.</>}>
        Сбросить пароль
      </DialogTitle>

      <label style={labelStyle} htmlFor="rp-password">Новый пароль</label>
      <input
        id="rp-password"
        data-autofocus
        autoComplete="off"
        spellCheck={false}
        style={input}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      <p style={hint}>{PASSWORD_HINT}</p>

      {error && <p style={errText}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button style={{ ...primaryBtn, opacity: canSubmit ? 1 : 0.55 }} disabled={!canSubmit} onClick={submit}>
          {busy ? "Сохранение…" : "Сбросить"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

const hint: CSSProperties = { margin: "-4px 0 0", fontSize: 12.5, color: "#94a3b8" };
