import { useRef, useState } from "react";
import "./ds.css";
import { useDismiss } from "./useDismiss";

// Меню профиля под аватаром (заменяет прежнюю кнопку «Выйти» в шапке). Аватар-кружок
// с инициалом роли; по клику — меню того же вида, что «Действия со схемой»: сверху роль
// (или «Администратор») тихой подписью, пункты словами — «Сменить пароль», «Токены для
// MCP», «Пользователи» (только администратору) и за чертой «Выйти». Закрытие по клику
// вне / Escape. Сам ничего не запрашивает: окна и переход на экран «Пользователи» —
// колбэки владельца (components/users/AccountMenu).
// Корень — область нового языка (.ds): меню стоит и в шапках экранов прежнего вида
// («Проекты», «Пользователи») и выглядит везде одинаково. Стили (ui/ds.css) импортирует
// этот модуль: экран «Проекты» чужих чанков с ними может не грузить.
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
      type="button"
      className="ds-menu-item"
      onClick={() => { setOpen(false); action(); }}
      role="menuitem"
    >
      {label}
    </button>
  );

  return (
    <div ref={ref} className="ds" style={{ position: "relative" }}>
      <button
        type="button"
        className="ds-avatar"
        onClick={() => setOpen((o) => !o)}
        title="Профиль"
        aria-label="Профиль"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {initial}
      </button>
      {open && (
        <div className="ds-menu ds-menu--end" role="menu">
          {/* Администратор — полные права, его роль не показываем: всегда архитектор. */}
          <div className="ds-menu-head">{isAdmin ? "Администратор" : role}</div>
          <div className="ds-menu-sep" aria-hidden="true" />
          {onChangePassword && item("Сменить пароль", onChangePassword)}
          {onOpenTokens && item("Токены для MCP", onOpenTokens)}
          {isAdmin && onOpenUsers && item("Пользователи", onOpenUsers)}
          <div className="ds-menu-sep" aria-hidden="true" />
          {item("Выйти", onLogout)}
        </div>
      )}
    </div>
  );
}
