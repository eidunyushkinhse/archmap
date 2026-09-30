import { useState } from "react";
import type { CSSProperties } from "react";
import { adminApi } from "../../api/admin";
import type { AdminUser, UserRole } from "../../types";
import Modal from "../../ui/Modal";
import { input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";
import { PASSWORD_HINT, ROLE_LABEL, ROLES } from "./userLabels";

/**
 * «Новый пользователь» (только администратор): логин, роль, признак администратора
 * и временный пароль. Почты нет — пароль администратор передаёт человеку сам,
 * поэтому поле открытое: его надо видеть, чтобы продиктовать или скопировать.
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = username.trim().length > 0 && password.length > 0 && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const user = await adminApi.create({ username: username.trim(), role, is_admin: isAdmin, password });
      onCreated(user);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать пользователя");
      setBusy(false);
    }
  }

  const onEnter = (e: React.KeyboardEvent) => { if (e.key === "Enter") void submit(); };

  return (
    <Modal onClose={onClose} boxStyle={{ width: 420, padding: 24 }}>
      <h3 style={title}>Новый пользователь</h3>

      <label style={labelStyle} htmlFor="nu-login">Логин</label>
      <input
        id="nu-login"
        data-autofocus
        autoComplete="off"
        style={input}
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        onKeyDown={onEnter}
      />

      <label style={labelStyle} htmlFor="nu-role">Роль</label>
      <select
        id="nu-role"
        style={input}
        value={role}
        onChange={(e) => setRole(e.target.value as UserRole)}
      >
        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
      </select>

      <label style={checkRow}>
        <input type="checkbox" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} />
        Администратор
      </label>

      <label style={labelStyle} htmlFor="nu-password">Временный пароль</label>
      <input
        id="nu-password"
        autoComplete="off"
        spellCheck={false}
        style={input}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={onEnter}
      />
      <p style={hint}>{PASSWORD_HINT}. Передайте пароль человеку сами, сменить его можно в меню профиля.</p>

      {error && <p style={errText}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button style={{ ...primaryBtn, opacity: canSubmit ? 1 : 0.55 }} disabled={!canSubmit} onClick={submit}>
          {busy ? "Создание…" : "Создать"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

const title: CSSProperties = { margin: "0 0 16px", fontSize: 18, fontWeight: 700, color: "#0f172a" };
const checkRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 8, margin: "2px 0 14px",
  fontSize: 14, color: "#1e293b", cursor: "pointer",
};
const hint: CSSProperties = { margin: "-4px 0 0", fontSize: 12.5, color: "#94a3b8", lineHeight: 1.45 };
const errText: CSSProperties = { color: "#dc2626", fontSize: 13, margin: "8px 0 0" };
