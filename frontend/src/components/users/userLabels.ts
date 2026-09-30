import type { UserRole } from "../../types";

// Подписи ролей на экране «Пользователи» и в его окнах: одно место на все.
export const ROLE_LABEL: Record<UserRole, string> = {
  architect: "Архитектор",
  viewer: "Наблюдатель",
};
export const ROLES: UserRole[] = ["architect", "viewer"];

// Правило пароля живёт на бэке (app/auth.py); здесь — только подсказка словами.
export const PASSWORD_HINT = "Не короче 8 символов";
