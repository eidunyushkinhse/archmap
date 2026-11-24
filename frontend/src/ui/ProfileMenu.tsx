import { useState } from "react";
import "./ds.css";
import { useMenu } from "./useMenu";

// Меню профиля под аватаром в шапках экранов. Аватар-кружок с инициалом роли; по клику —
// меню того же вида, что «Действия со схемой»: сверху роль (или «Администратор») тихой
// подписью, за чертой пункты словами («Сменить пароль», «Токены для MCP», «Пользователи»
// только администратору) и за второй чертой «Выйти». Закрытие по клику вне и Escape,
// стрелки и возврат фокуса на аватар — общим хуком ui/useMenu. Сам ничего не запрашивает:
// окна и переход на экран «Пользователи» — колбэки владельца (components/users/AccountMenu).
// Корень — область нового языка (.ds) и корень меню (ds-menu-root): меню выглядит одинаково
// в любой шапке. Стили (ui/ds.css) импортирует этот модуль: экран «Проекты» чужих чанков с
// ними может не грузить.
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
  const { wrapRef, triggerRef, menuRef, onKeyDown, pick } = useMenu(open, setOpen);
  // инициал из роли («Архитектор» → «А», «Наблюдатель» → «Н»); пусто → «—»
  const initial = role.trim().charAt(0).toUpperCase() || "—";

  // Пункт меню: фокус на кнопку меню, закрывает поповер и зовёт действие (useMenu.pick).
  const item = (label: string, action: () => void) => (
    <button
      type="button"
      className="ds-menu-item"
      onClick={() => pick(action)}
      role="menuitem"
    >
      {label}
    </button>
  );

  return (
    <div ref={wrapRef} className="ds ds-menu-root">
      <button
        ref={triggerRef}
        type="button"
        className="ds-avatar"
        onClick={() => setOpen((o) => !o)}
        title="Профиль"
        aria-label="Профиль"
        aria-haspopup="menu"
        aria-expanded={open}
        onKeyDown={onKeyDown}
      >
        {initial}
      </button>
      {open && (
        <div ref={menuRef} className="ds-menu ds-menu--end" role="menu" onKeyDown={onKeyDown}>
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
