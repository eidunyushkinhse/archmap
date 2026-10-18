import { useRef, useState } from "react";
import type { CSSProperties } from "react";
import "./chrome.css";
import { useDismiss } from "./useDismiss";

// Меню профиля под аватаром (заменяет прежнюю кнопку «Выйти» в шапке). Аватар-кружок
// с инициалом роли; по клику — меню того же вида, что «Действия со схемой» и ⋯ карточки
// проекта: сверху роль (и «Администратор») приглушённой подписью, пункты словами —
// «Сменить пароль», «Токены для MCP», «Пользователи» (только администратору) и за
// разделителем «Выйти». Закрытие по клику вне / Escape. Сам ничего не запрашивает: окна и
// переход на экран «Пользователи» — колбэки владельца (components/users/AccountMenu).
// Ховер пунктов — .pf-item в chrome.css: файл импортируется ЗДЕСЬ, иначе на странице,
// которая его не грузит (список проектов), пункты получали системный серый фон кнопок.
interface Props {
  role: string;
  onLogout: () => void;
  // Администратор видит пункт «Пользователи» (при переданном onOpenUsers).
  isAdmin?: boolean;
  onChangePassword?: () => void;
  // Окно «Токены для MCP» — личные токены для подключения ИИ-агента к /mcp.
  onOpenTokens?: () => void;
  onOpenUsers?: () => void;
}

export default function ProfileMenu({ role, onLogout, isAdmin = false, onChangePassword, onOpenTokens, onOpenUsers }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // инициал из роли («Архитектор» → «А», «Наблюдатель» → «Н»); пусто → «—»
  const initial = role.trim().charAt(0).toUpperCase() || "—";

  useDismiss(open, ref, setOpen);

  // Пункт меню: закрывает поповер и зовёт действие.
  const item = (label: string, action: () => void) => (
    <button
      className="pf-item"
      style={menuItem}
      onClick={() => { setOpen(false); action(); }}
      role="menuitem"
    >
      {label}
    </button>
  );

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
          {/* Администратор — полные права, его роль не показываем: всегда архитектор. */}
          <div style={menuHead}>{isAdmin ? "Администратор" : role}</div>
          <div style={sep} aria-hidden="true" />
          {onChangePassword && item("Сменить пароль", onChangePassword)}
          {onOpenTokens && item("Токены для MCP", onOpenTokens)}
          {isAdmin && onOpenUsers && item("Пользователи", onOpenUsers)}
          <div style={sep} aria-hidden="true" />
          {item("Выйти", onLogout)}
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
// Коробка и пункты — как у меню «Действия со схемой» (SchemaActions) и ⋯ карточки проекта.
const menu: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 8px)",
  right: 0,
  width: 220,
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  boxShadow: "0 16px 40px rgba(15,23,42,.16)",
  padding: 6,
  zIndex: 20,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};
const menuHead: CSSProperties = {
  padding: "6px 10px 4px",
  fontSize: 12.5,
  color: "#64748b",
  lineHeight: 1.35,
};
// Разделитель — как .adm-sep у меню «Добавить документацию».
const sep: CSSProperties = { height: 1, background: "#eef0f2", margin: "4px 6px" };
const menuItem: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  padding: "8px 10px",
  border: "none",
  // Фон — в .pf-item (chrome.css): инлайновый background перебивал бы :hover.
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13.5,
  color: "#1e293b",
  lineHeight: 1.35,
};
