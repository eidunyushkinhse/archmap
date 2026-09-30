import type { AdminUser, AdminUserCreate, AdminUserUpdate } from "../types";
import { api } from "./client";

// Админка пользователей (/admin/users): только администратору, остальным бэк
// отвечает 403. Удаления нет намеренно — вместо него блокировка (is_active=false).
export const adminApi = {
  list: (): Promise<AdminUser[]> => api.get<AdminUser[]>("/admin/users"),
  create: (body: AdminUserCreate): Promise<AdminUser> =>
    api.post<AdminUser>("/admin/users", body),
  update: (id: string, body: AdminUserUpdate): Promise<AdminUser> =>
    api.patch<AdminUser>(`/admin/users/${id}`, body),
  resetPassword: (id: string, newPassword: string): Promise<void> =>
    api.post<undefined>(`/admin/users/${id}/password`, { new_password: newPassword }),
};
