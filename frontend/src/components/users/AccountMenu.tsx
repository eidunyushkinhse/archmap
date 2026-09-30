import { useState } from "react";
import { getIsAdmin, getUserRole } from "../../api/auth";
import ProfileMenu from "../../ui/ProfileMenu";
import ChangePasswordDialog from "./ChangePasswordDialog";

/**
 * Меню профиля в шапках экранов: ProfileMenu + окно «Сменить пароль». Роль и
 * признак администратора читает из кэша «кто я» (api/auth): App перерисовывает
 * дерево, когда пришёл ответ /auth/me, и меню видит свежие значения.
 * onOpenUsers не передают на самом экране «Пользователи» — вести некуда.
 */

interface Props {
  onLogout: () => void;
  onOpenUsers?: () => void;
}

export default function AccountMenu({ onLogout, onOpenUsers }: Props) {
  const [changingPassword, setChangingPassword] = useState(false);
  const isArchitect = getUserRole() === "architect";
  return (
    <>
      <ProfileMenu
        role={isArchitect ? "Архитектор" : "Наблюдатель"}
        isAdmin={getIsAdmin()}
        onLogout={onLogout}
        onChangePassword={() => setChangingPassword(true)}
        onOpenUsers={onOpenUsers}
      />
      {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
    </>
  );
}
