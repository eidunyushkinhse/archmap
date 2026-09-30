import { useCallback, useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { adminApi } from "../api/admin";
import { fetchMe } from "../api/auth";
import type { AdminUser, AdminUserUpdate, UserRole } from "../types";
import AccountMenu from "../components/users/AccountMenu";
import NewUserDialog from "../components/users/NewUserDialog";
import ResetPasswordDialog from "../components/users/ResetPasswordDialog";
import { ROLE_LABEL, ROLES } from "../components/users/userLabels";
import BrandLink from "../ui/BrandLink";
import ConfirmDialog from "../ui/ConfirmDialog";
import { PlusIcon } from "../ui/icons";
import "../ui/chrome.css";

/**
 * Экран «Пользователи» (#/admin/users, только администратор): таблица учёток и
 * действия над ними. Удаления нет: в проектах живут created_by/updated_by, поэтому
 * вместо удаления — блокировка. Защиты «себя не блокировать, последнего админа не
 * трогать» проверяет бэк; здесь те же кнопки заранее отключены с подсказкой почему.
 */

interface Props {
  onAllProjects: () => void;
  onLogout: () => void;
}

type Dialog =
  | { kind: "create" }
  | { kind: "reset" | "block" | "revoke"; user: AdminUser }
  | null;

export default function UsersPage({ onAllProjects, onLogout }: Props) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      // «Кто я» — тут же: без него не отличить свою строку (себя блокировать нельзя).
      const [list, me] = await Promise.all([adminApi.list(), fetchMe()]);
      setUsers(list);
      setMeId(me.id);
      setError(null);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить пользователей");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- первичная загрузка списка при маунте (reload асинхронно кладёт ответ в стейт)
  useEffect(() => { void reload(); }, [reload]);

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }

  function closeDialog() {
    setDialog(null);
    setDialogError(null);
  }

  // Правка строки: роль, админ, блокировка. Ответ бэка заменяет строку целиком.
  async function patch(user: AdminUser, body: AdminUserUpdate, done: string): Promise<boolean> {
    setBusy(true);
    try {
      const updated = await adminApi.update(user.id, body);
      setUsers((list) => list.map((u) => (u.id === updated.id ? updated : u)));
      // Свою роль сменили — обновить «кто я», чтобы меню и страницы её увидели.
      if (updated.id === meId) void fetchMe();
      flash(done);
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Не удалось сохранить";
      if (dialog) setDialogError(msg);
      else setError(msg);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function confirmDialog() {
    if (dialog?.kind === "block") {
      if (await patch(dialog.user, { is_active: false }, "Пользователь заблокирован")) closeDialog();
    } else if (dialog?.kind === "revoke") {
      if (await patch(dialog.user, { is_admin: false }, "Права администратора сняты")) closeDialog();
    }
  }

  const activeAdmins = users.filter((u) => u.is_admin && u.is_active).length;

  return (
    <div style={page}>
      <div style={topBar}>
        <BrandLink onClick={onAllProjects} />
        <AccountMenu onLogout={onLogout} />
      </div>

      <div style={container}>
        <button className="crumb" style={backLink} onClick={onAllProjects}>← Все проекты</button>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <h1 style={h1}>Пользователи</h1>
          <button style={newBtn} onClick={() => setDialog({ kind: "create" })}>
            <PlusIcon /> Новый пользователь
          </button>
        </div>

        {error && <p style={{ color: "#dc2626", fontSize: 14 }}>{error}</p>}
        {loading && <p style={{ color: "#64748b", fontSize: 14 }}>Загрузка…</p>}

        {!loading && users.length > 0 && (
          <div style={tableBox}>
            <table style={table}>
              <thead>
                <tr>
                  <th style={th}>Логин</th>
                  <th style={th}>Роль</th>
                  <th style={th}>Администратор</th>
                  <th style={th}>Статус</th>
                  <th style={th}>Создан</th>
                  <th style={th} aria-label="Действия" />
                </tr>
              </thead>
              <tbody>
                {users.map((u) => {
                  const isSelf = u.id === meId;
                  const lastAdmin = u.is_admin && u.is_active && activeAdmins <= 1;
                  // Почему нельзя: себя — всегда, последнего активного админа — тоже.
                  const blockLock = isSelf ? "Нельзя заблокировать себя" : lastAdmin ? "Это последний администратор" : null;
                  const revokeLock = isSelf ? "Нельзя снять права с себя" : lastAdmin ? "Это последний администратор" : null;
                  return (
                    <tr key={u.id} data-testid={`user-row-${u.username}`}>
                      <td style={td}>
                        <span style={{ fontWeight: 600, color: "#0f172a" }}>{u.username}</span>
                        {isSelf && <span style={selfMark}>вы</span>}
                      </td>
                      <td style={td}>
                        <select
                          aria-label={`Роль ${u.username}`}
                          style={roleSelect}
                          value={u.role}
                          disabled={busy}
                          onChange={(e) => void patch(u, { role: e.target.value as UserRole }, "Роль изменена")}
                        >
                          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                        </select>
                      </td>
                      <td style={td}>{u.is_admin ? "Да" : "Нет"}</td>
                      <td style={td}>
                        <span style={u.is_active ? activeBadge : blockedBadge}>
                          {u.is_active ? "Активен" : "Заблокирован"}
                        </span>
                      </td>
                      <td style={{ ...td, color: "#64748b", whiteSpace: "nowrap" }}>{fmtDate(u.created_at)}</td>
                      <td style={{ ...td, textAlign: "right" }}>
                        <div style={actions}>
                          <RowAction onClick={() => setDialog({ kind: "reset", user: u })} disabled={busy}>
                            Сбросить пароль
                          </RowAction>
                          {u.is_admin ? (
                            <RowAction
                              onClick={() => setDialog({ kind: "revoke", user: u })}
                              disabled={busy}
                              lockedReason={revokeLock}
                            >
                              Снять админа
                            </RowAction>
                          ) : (
                            <RowAction
                              onClick={() => void patch(u, { is_admin: true }, "Права администратора выданы")}
                              disabled={busy}
                            >
                              Сделать админом
                            </RowAction>
                          )}
                          {u.is_active ? (
                            <RowAction
                              onClick={() => setDialog({ kind: "block", user: u })}
                              disabled={busy}
                              lockedReason={blockLock}
                              danger
                            >
                              Заблокировать
                            </RowAction>
                          ) : (
                            <RowAction
                              onClick={() => void patch(u, { is_active: true }, "Пользователь разблокирован")}
                              disabled={busy}
                            >
                              Разблокировать
                            </RowAction>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog?.kind === "create" && (
        <NewUserDialog
          onClose={closeDialog}
          onCreated={(user) => {
            closeDialog();
            setUsers((list) => [...list, user].sort((a, b) => a.username.localeCompare(b.username, "ru")));
            flash("Пользователь создан");
          }}
        />
      )}
      {dialog?.kind === "reset" && (
        <ResetPasswordDialog
          user={dialog.user}
          onClose={closeDialog}
          onDone={() => { closeDialog(); flash("Пароль сброшен"); }}
        />
      )}
      {dialog?.kind === "block" && (
        <ConfirmDialog
          title={`Заблокировать «${dialog.user.username}»?`}
          lead="Пользователь не сможет войти, открытые сессии закроются. Разблокировать можно в любой момент."
          confirmLabel="Заблокировать"
          busyLabel="Блокировка…"
          busy={busy}
          error={dialogError}
          onConfirm={() => void confirmDialog()}
          onCancel={closeDialog}
        />
      )}
      {dialog?.kind === "revoke" && (
        <ConfirmDialog
          title={`Снять права администратора с «${dialog.user.username}»?`}
          lead="Пользователь больше не сможет управлять учётными записями. Роль останется прежней."
          confirmLabel="Снять"
          busyLabel="Сохранение…"
          busy={busy}
          error={dialogError}
          onConfirm={() => void confirmDialog()}
          onCancel={closeDialog}
        />
      )}

      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}

// Кнопка действия в строке. Отключённая по правилу (себя, последний админ) несёт
// подсказку на обёртке: у disabled-кнопки браузеры не всегда показывают title.
function RowAction({
  children, onClick, disabled, lockedReason = null, danger = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled: boolean;
  lockedReason?: string | null;
  danger?: boolean;
}) {
  const locked = lockedReason !== null;
  return (
    <span title={lockedReason ?? undefined} style={{ display: "inline-flex" }}>
      <button
        style={{ ...rowBtn, color: danger ? "#dc2626" : "#1e293b", opacity: locked ? 0.45 : 1 }}
        disabled={disabled || locked}
        onClick={onClick}
      >
        {children}
      </button>
    </span>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}

// ── Стили (шапка и контейнер — как у лендинга «Проекты») ─────────────────────
const page: CSSProperties = { height: "100vh", overflowY: "auto", background: "#f8fafc" };
const topBar: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 24px", background: "#fff", borderBottom: "1px solid #e2e8f0",
};
const container: CSSProperties = { maxWidth: 1120, margin: "0 auto", padding: "20px 24px 60px" };
const backLink: CSSProperties = {
  display: "inline-flex", alignItems: "center", padding: "4px 8px", margin: "0 0 10px -8px",
  border: "none", borderRadius: 8, background: "none", color: "#64748b",
  fontSize: 13.5, fontWeight: 600, cursor: "pointer",
};
const h1: CSSProperties = { margin: 0, fontSize: 26, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em" };
const newBtn: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 16px",
  background: "#2563eb", color: "#fff", border: "none", borderRadius: 10,
  fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
};
const tableBox: CSSProperties = {
  marginTop: 22, background: "#fff", border: "1px solid #e8edf3", borderRadius: 14, overflowX: "auto",
};
const table: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 14 };
const th: CSSProperties = {
  textAlign: "left", padding: "11px 14px", fontSize: 12.5, fontWeight: 700, color: "#64748b",
  borderBottom: "1px solid #eef2f6", whiteSpace: "nowrap",
};
const td: CSSProperties = { padding: "10px 14px", borderBottom: "1px solid #f1f5f9", color: "#334155", verticalAlign: "middle" };
const selfMark: CSSProperties = {
  marginLeft: 8, padding: "2px 8px", borderRadius: 999, background: "#eff6ff",
  color: "#1d4ed8", fontSize: 12, fontWeight: 600,
};
const roleSelect: CSSProperties = {
  padding: "5px 8px", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 13.5,
  color: "#0f172a", background: "#fff",
};
const badgeBase: CSSProperties = {
  display: "inline-flex", padding: "3px 10px", borderRadius: 999, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap",
};
const activeBadge: CSSProperties = { ...badgeBase, background: "#f0fdf4", color: "#15803d" };
const blockedBadge: CSSProperties = { ...badgeBase, background: "#fef2f2", color: "#b91c1c" };
const actions: CSSProperties = { display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" };
const rowBtn: CSSProperties = {
  padding: "6px 10px", border: "1px solid #e2e8f0", borderRadius: 8, background: "#fff",
  fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
};
const toastStyle: CSSProperties = {
  position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
  background: "#0f172a", color: "#fff", padding: "10px 18px", borderRadius: 10,
  fontSize: 14, boxShadow: "0 12px 30px rgba(15,23,42,.28)", zIndex: 50,
  pointerEvents: "none", // информативный снекбар не должен глотать клики под собой
};
