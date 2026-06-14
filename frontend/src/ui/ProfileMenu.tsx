import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { LogoutIcon } from "./icons";

// Меню профиля под аватаром (заменяет прежнюю кнопку «Выйти» в шапке). Аватар-кружок
// с инициалом роли; по клику — поповер с бейджем роли и пунктом «Выйти». Закрытие по
// клику вне / Escape. Имя пользователя в проекте пока не хранится — показываем роль.
interface Props {
  role: string;
  onLogout: () => void;
}

export default function ProfileMenu({ role, onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // инициал из роли («Архитектор» → «А», «Наблюдатель» → «Н»); пусто → «—»
  const initial = role.trim().charAt(0).toUpperCase() || "—";

  // Закрытие по клику вне поповера и по Escape (как в SchemaAlerts).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="pf-avatar"
        style={avatar}
        onClick={() => setOpen((o) => !o)}
        title="Профиль"
        aria-label="Профиль"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {initial}
      </button>
      {open && (
        <div style={menu} role="menu">
          <div style={menuHead}>
            <span style={roleBadge}>
              <span style={roleDot} />
              {role}
            </span>
          </div>
          <button
            className="pf-logout"
            style={logoutItem}
            onClick={() => { setOpen(false); onLogout(); }}
            role="menuitem"
          >
            <LogoutIcon />
            Выйти
          </button>
        </div>
      )}
    </div>
  );
}

const avatar: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 34,
  height: 34,
  flex: "none",
  borderRadius: "50%",
  background: "#eff6ff",
  color: "#1d4ed8",
  border: "1px solid #dbeafe",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  transition: "background .12s ease, border-color .12s ease",
};
const menu: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  width: 220,
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  boxShadow: "0 16px 40px rgba(15,23,42,.16)",
  padding: 8,
  zIndex: 20,
};
const menuHead: CSSProperties = {
  padding: "4px 6px 10px",
  borderBottom: "1px solid #eef2f6",
  marginBottom: 6,
};
const roleBadge: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  padding: "4px 10px",
  borderRadius: 999,
  background: "#eff6ff",
  color: "#1d4ed8",
  fontSize: 12.5,
  fontWeight: 600,
};
const roleDot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "#2563eb",
  flex: "none",
};
const logoutItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  width: "100%",
  padding: "8px 10px",
  background: "none",
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
  color: "#dc2626",
  fontSize: 13.5,
  textAlign: "left",
  transition: "background .12s ease",
};
