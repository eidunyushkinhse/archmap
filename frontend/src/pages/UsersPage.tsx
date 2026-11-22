import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { listToast as toastStyle } from "../ui/pageChrome";
import { adminApi } from "../api/admin";
import { fetchMe } from "../api/auth";
import type { AdminUser, AdminUserUpdate, UserRole } from "../types";
import AccountMenu from "../components/users/AccountMenu";
import NewUserDialog from "../components/users/NewUserDialog";
import ResetPasswordDialog from "../components/users/ResetPasswordDialog";
import { ROLE_LABEL, ROLES } from "../components/users/userLabels";
import BrandLink from "../ui/BrandLink";
import ConfirmDialog from "../ui/ConfirmDialog";
import { ChevronDownIcon, KebabIcon } from "../ui/icons";
import { useDismiss } from "../ui/useDismiss";
import { useMessageToast } from "./useToast";
import "../ui/ds.css";
import "./listPages.css";

/**
 * Экран «Пользователи» (#/admin/users, только администратор; редизайн, фаза 12а): тихая
 * таблица учёток, действия строки — в меню кнопки-значка. Удаления нет: в проектах живут
 * created_by/updated_by, поэтому вместо удаления — блокировка. Защиты «себя не блокировать,
 * последнего админа не трогать» проверяет бэк; здесь те же пункты меню заранее заперты, а
 * причина стоит второй строкой пункта.
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
  // Тост результата действия: таймер с очисткой и продлением (раньше — setTimeout без
  // очистки, аудит F-17).
  const [toast, flash] = useMessageToast(2600);

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

  // Действия строки по порядку пунктов меню: что делает каждое, не меняется (окно,
  // подтверждение или запись сразу).
  function rowActions(u: AdminUser): RowAction[] {
    const isSelf = u.id === meId;
    const lastAdmin = u.is_admin && u.is_active && activeAdmins <= 1;
    // Почему нельзя: себя — всегда, последнего активного админа — тоже.
    const blockLock = isSelf ? "Нельзя заблокировать себя" : lastAdmin ? "Это последний администратор" : null;
    const revokeLock = isSelf ? "Нельзя снять права с себя" : lastAdmin ? "Это последний администратор" : null;
    return [
      { label: "Сбросить пароль", run: () => setDialog({ kind: "reset", user: u }) },
      u.is_admin
        ? { label: "Снять права администратора", run: () => setDialog({ kind: "revoke", user: u }), locked: revokeLock }
        : { label: "Сделать администратором", run: () => void patch(u, { is_admin: true }, "Права администратора выданы") },
      u.is_active
        ? { label: "Заблокировать", run: () => setDialog({ kind: "block", user: u }), locked: blockLock, danger: true }
        : { label: "Разблокировать", run: () => void patch(u, { is_active: true }, "Пользователь разблокирован") },
    ];
  }

  return (
    <div className="ds lp-page">
      <header className="ds-head">
        <div className="ds-head-left">
          <BrandLink onClick={onAllProjects} />
        </div>
        <div className="ds-head-acts">
          <AccountMenu onLogout={onLogout} />
        </div>
      </header>

      <main className="lp-main lp-main--crumb">
        <div className="lp-crumbs">
          <button type="button" onClick={onAllProjects}>Все проекты</button>
        </div>
        <div className="lp-title-row">
          <h1 className="lp-title">Пользователи</h1>
          <button type="button" className="ds-btn ds-btn--primary" onClick={() => setDialog({ kind: "create" })}>
            Новый пользователь
          </button>
        </div>

        {error && <p className="ds-danger lp-note">{error}</p>}
        {loading && <p className="ds-empty lp-note">Загрузка</p>}

        {!loading && users.length > 0 && (
          <table className="ds-table lp-users">
            <thead>
              <tr>
                <th>Логин</th>
                <th>Роль</th>
                <th>Администратор</th>
                <th>Статус</th>
                <th>Создан</th>
                <th aria-label="Действия" />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} data-testid={`user-row-${u.username}`}>
                  <td>
                    <span className="lp-login">{u.username}</span>
                    {u.id === meId && <span className="lp-self">вы</span>}
                  </td>
                  <td>
                    <span className="ds-select lp-role">
                      <select
                        aria-label={`Роль ${u.username}`}
                        value={u.role}
                        // Администратор всегда архитектор: роль меняется, только сняв права.
                        disabled={busy || u.is_admin}
                        title={u.is_admin ? "Администратор всегда архитектор" : undefined}
                        onChange={(e) => void patch(u, { role: e.target.value as UserRole }, "Роль изменена")}
                      >
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                      <ChevronDownIcon />
                    </span>
                  </td>
                  <td className={u.is_admin ? undefined : "lp-quiet"}>{u.is_admin ? "Да" : "Нет"}</td>
                  <td className={u.is_active ? "lp-quiet" : "lp-blocked"}>{u.is_active ? "Активен" : "Заблокирован"}</td>
                  <td className="lp-quiet lp-nowrap">{fmtDate(u.created_at)}</td>
                  <td className="lp-acts">
                    <RowMenu username={u.username} busy={busy} actions={rowActions(u)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>

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
          busyLabel="Блокируем"
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
          busyLabel="Снимаем"
          busy={busy}
          error={dialogError}
          onConfirm={() => void confirmDialog()}
          onCancel={closeDialog}
        />
      )}

      {/* Тост прежнего вида (legacy-root держит прежние метрики текста внутри .ds). */}
      {toast && <div className="legacy-root" style={toastStyle}>{toast}</div>}
    </div>
  );
}

// Действие строки. locked — причина, по которой действие заперто правилом (себя, последний
// администратор); danger — опасный пункт («Заблокировать»).
interface RowAction {
  label: string;
  run: () => void;
  locked?: string | null;
  danger?: boolean;
}

// Меню действий строки: кнопка-значок, меню у её правого края. Закрывается выбором пункта,
// щелчком мимо и Escape (useDismiss). Пока идёт запись, кнопка и пункты заперты. Запертый
// по правилу пункт остаётся в меню, причина — второй строкой пункта: имя пункта — подпись
// (aria-label), причина — его описание (aria-describedby). Меню не помещается под кнопкой,
// а над ней места больше (нижние строки длинной таблицы) — раскрывается вверх.
function RowMenu({ username, busy, actions }: { username: string; busy: boolean; actions: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const idBase = useId();
  useDismiss(open, ref, setOpen);

  // До отрисовки (без вспышки вниз, потом вверх), как у components/AddDocsMenu.
  useLayoutEffect(() => {
    if (!open) return;
    const wrap = ref.current;
    const menu = menuRef.current;
    if (!wrap || !menu) return;
    const rect = wrap.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom;
    setUp(below < menu.offsetHeight + 8 && rect.top > below);
  }, [open]);

  return (
    <div ref={ref} className="lp-row-menu">
      <button
        type="button"
        className="ds-icon-btn"
        title="Действия"
        aria-label={`Действия с пользователем ${username}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        <KebabIcon />
      </button>
      {open && (
        <div ref={menuRef} className={"ds-menu ds-menu--end" + (up ? " lp-menu--up" : "")} role="menu">
          {actions.map((a, i) => {
            const why = a.locked ? `${idBase}-${i}` : undefined;
            return (
              <button
                key={a.label}
                type="button"
                role="menuitem"
                className={"ds-menu-item lp-menu-item" + (a.danger ? " ds-menu-item--danger" : "")}
                disabled={busy || why !== undefined}
                aria-label={why ? a.label : undefined}
                aria-describedby={why}
                onClick={() => { setOpen(false); a.run(); }}
              >
                <span>{a.label}</span>
                {why && <span id={why} className="lp-menu-why">{a.locked}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "numeric" });
}
