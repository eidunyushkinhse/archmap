import { useState } from "react";
import type { CSSProperties } from "react";
import { adminApi } from "../../api/admin";
import type { AdminUser } from "../../types";
import Modal from "../../ui/Modal";
import { input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await adminApi.resetPassword(user.id, password);
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось сбросить пароль");
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} boxStyle={{ width: 400, padding: 24 }}>
      <h3 style={title}>Сбросить пароль</h3>
      <p style={lead}>Новый пароль для «{user.username}». Передайте его человеку сами.</p>

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

const title: CSSProperties = { margin: "0 0 10px", fontSize: 18, fontWeight: 700, color: "#0f172a" };
const lead: CSSProperties = { margin: "0 0 16px", fontSize: 14, color: "#475569", lineHeight: 1.5 };
const hint: CSSProperties = { margin: "-4px 0 0", fontSize: 12.5, color: "#94a3b8" };
const errText: CSSProperties = { color: "#dc2626", fontSize: 13, margin: "8px 0 0" };
