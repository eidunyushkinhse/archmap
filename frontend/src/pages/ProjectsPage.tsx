import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { fetchMe, getCanCreateProject, getIsGuest, getMe, getUserRole } from "../api/auth";
import { projectsApi } from "../api/projects";
import type { Project } from "../types";
import CreateProjectDialog from "../components/project/CreateProjectDialog";
import EditProjectDialog from "../components/project/EditProjectDialog";
import ProjectAccessDialog from "../components/project/ProjectAccessDialog";
import { ArchiveDialog, DeleteForeverDialog, RestoreDialog } from "../components/project/ProjectDialogs";
import ProjectCard from "../components/project/ProjectCard";
import AccountMenu from "../components/users/AccountMenu";
import { LogoMark, PlusIcon } from "../ui/icons";

/**
 * Лендинг «Проекты»: сетка карточек со схемой-превью, метаданными и меню ⋯.
 * Табы Активные/Архив, поиск, пустые состояния. Открытие проекта — клик по телу
 * карточки. Создать проект — глобальная роль architect; управлять им
 * (редактировать, архив, восстановить, удалить) — только его владелец (my_role);
 * окно «Доступ» открывает каждый, кто видит проект (не-владельцу — на чтение).
 *
 * Гость демо-стенда (docs/tasks/demo-mode.md): над списком плашка песочницы, «Доступа»
 * нет, а «Новый проект» гаснет с подсказкой, когда свой проект уже есть (решает
 * сервер: can_create_project в /auth/me).
 */

interface Props {
  onOpenProject: (id: string) => void;
  onLogout: () => void;
  // Экран «Пользователи» — пункт меню профиля, виден только администратору.
  onOpenUsers: () => void;
}

type Tab = "active" | "archived";
type Dialog =
  | { kind: "create" }
  | { kind: "edit" | "archive" | "restore" | "delete" | "access"; project: Project }
  | null;

export default function ProjectsPage({ onOpenProject, onLogout, onOpenUsers }: Props) {
  const isArchitect = getUserRole() === "architect";
  const isGuest = getIsGuest();
  // Гостю: создать ещё один проект можно, только пока предел не выбран.
  const createBlocked = isGuest && !getCanCreateProject();
  const guestName = isGuest ? (getMe()?.username ?? null) : null;
  const [active, setActive] = useState<Project[]>([]);
  const [archived, setArchived] = useState<Project[]>([]);
  const [tab, setTab] = useState<Tab>("active");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    // Гостю «можно ли создать ещё» пересчитывает сервер: список мог измениться.
    if (getIsGuest()) fetchMe().catch(() => {});
    try {
      const [a, ar] = await Promise.all([projectsApi.list(false), projectsApi.list(true)]);
      setActive(a);
      setArchived(ar);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить проекты");
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- первичная загрузка списков при маунте (reload асинхронно тянет проекты и кладёт в стейт)
  useEffect(() => { void reload(); }, [reload]);

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }

  const list = tab === "active" ? active : archived;
  const q = query.trim().toLowerCase();
  const filtered = q
    ? list.filter(
        (p) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
      )
    : list;

  return (
    <div style={page}>
      {/* Шапка лендинга */}
      <div style={topBar}>
        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
          <LogoMark />
          <span style={{ fontSize: 16.5, fontWeight: 700, letterSpacing: "-0.01em", color: "#0f172a" }}>
            Arch<span style={{ color: "#2563eb" }}>Map</span>
          </span>
        </div>
        <AccountMenu onLogout={onLogout} onOpenUsers={onOpenUsers} />
      </div>

      <div style={container}>
        {isGuest && (
          <div style={sandboxBanner} role="note">
            <div>
              <b style={{ color: "#78350f" }}>Это песочница.</b> Она удалится через сутки бездействия. Не вносите сюда рабочие данные.
            </div>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h1 style={h1}>Проекты</h1>
          </div>
          {isArchitect && (createBlocked ? (
            <BlockedNewButton />
          ) : (
            <button style={newBtn} onClick={() => setDialog({ kind: "create" })}>
              <PlusIcon /> Новый проект
            </button>
          ))}
        </div>

        {/* Табы + поиск */}
        <div style={controls}>
          <div style={{ display: "flex", gap: 6 }}>
            <TabBtn active={tab === "active"} onClick={() => setTab("active")}>
              Активные <span style={countPill}>{active.length}</span>
            </TabBtn>
            <TabBtn active={tab === "archived"} onClick={() => setTab("archived")}>
              Архив <span style={countPill}>{archived.length}</span>
            </TabBtn>
          </div>
          <input
            style={search}
            placeholder="Поиск по имени или описанию"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {error && <p style={{ color: "#dc2626", fontSize: 14 }}>{error}</p>}
        {loading && <p style={{ color: "#64748b", fontSize: 14 }}>Загрузка…</p>}

        {!loading && filtered.length === 0 ? (
          <EmptyState
            tab={tab}
            hasQuery={q.length > 0}
            isArchitect={isArchitect && !createBlocked}
            onCreate={() => setDialog({ kind: "create" })}
          />
        ) : (
          <div style={grid}>
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                archivedTab={tab === "archived"}
                canShare={!isGuest}
                updaterLabel={guestName !== null && p.updated_by === guestName ? "Гость" : undefined}
                onOpen={() => onOpenProject(p.id)}
                onAccess={() => setDialog({ kind: "access", project: p })}
                onEdit={() => setDialog({ kind: "edit", project: p })}
                onArchive={() => setDialog({ kind: "archive", project: p })}
                onRestore={() => setDialog({ kind: "restore", project: p })}
                onDelete={() => setDialog({ kind: "delete", project: p })}
              />
            ))}
          </div>
        )}
      </div>

      {/* Диалоги */}
      {dialog?.kind === "create" && (
        <CreateProjectDialog
          projects={active}
          onClose={() => setDialog(null)}
          onCreated={(id) => { setDialog(null); onOpenProject(id); }}
        />
      )}
      {dialog?.kind === "edit" && (
        <EditProjectDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onSaved={() => { setDialog(null); flash("Проект обновлён"); void reload(); }}
        />
      )}
      {dialog?.kind === "access" && (
        <ProjectAccessDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onChanged={() => void reload()}
        />
      )}
      {dialog?.kind === "archive" && (
        <ArchiveDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); flash("Проект отправлен в архив"); void reload(); }}
        />
      )}
      {dialog?.kind === "restore" && (
        <RestoreDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); flash("Проект восстановлен"); void reload(); }}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteForeverDialog
          project={dialog.project}
          onClose={() => setDialog(null)}
          onDone={() => { setDialog(null); flash("Проект удалён"); void reload(); }}
        />
      )}

      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}

// Подсказка к погашенной кнопке (docs/tasks/demo-mode.md, экран 2).
const GUEST_LIMIT_HINT = "В демо можно создать один свой проект. Удалите его, чтобы создать другой.";

// «Новый проект», когда гость уже держит предельное число проектов: кнопка видна, но
// не действует; по наведению и фокусу — подсказка, что делать.
function BlockedNewButton() {
  const [tip, setTip] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => setTip(true)}
      onMouseLeave={() => setTip(false)}
    >
      <button
        style={{ ...newBtn, ...newBtnBlocked }}
        aria-disabled="true"
        aria-describedby={tip ? "guest-limit-tip" : undefined}
        onFocus={() => setTip(true)}
        onBlur={() => setTip(false)}
      >
        <PlusIcon /> Новый проект
      </button>
      {tip && <span id="guest-limit-tip" role="tooltip" style={tipStyle}>{GUEST_LIMIT_HINT}</span>}
    </span>
  );
}

function EmptyState({
  tab, hasQuery, isArchitect, onCreate,
}: { tab: Tab; hasQuery: boolean; isArchitect: boolean; onCreate: () => void }) {
  if (hasQuery) {
    return <div style={empty}><p style={{ color: "#64748b" }}>Ничего не найдено</p></div>;
  }
  if (tab === "archived") {
    return <div style={empty}><p style={{ color: "#94a3b8" }}>В архиве пусто</p></div>;
  }
  return (
    <div style={empty}>
      <div style={emptyIcon}><LogoMark size={44} /></div>
      <h3 style={{ margin: "14px 0 4px", color: "#1e293b", fontSize: 18 }}>Пока нет ни одного проекта</h3>
      <p style={{ color: "#64748b", margin: "0 0 18px", fontSize: 14 }}>
        Создайте первый проект — это отдельная изолированная схема системы.
      </p>
      {isArchitect && (
        <button style={newBtn} onClick={onCreate}><PlusIcon /> Создать первый проект</button>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ ...tabBtn, ...(active ? tabActive : {}) }}>{children}</button>
  );
}

// ── Стили ─────────────────────────────────────────────────────────────────────
const page: CSSProperties = { height: "100vh", overflowY: "auto", background: "#f8fafc" };
const topBar: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "12px 24px", background: "#fff", borderBottom: "1px solid #e2e8f0",
};
const container: CSSProperties = { maxWidth: 1120, margin: "0 auto", padding: "28px 24px 60px" };
const h1: CSSProperties = { margin: 0, fontSize: 26, fontWeight: 800, color: "#0f172a", letterSpacing: "-0.02em" };
const newBtn: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, padding: "10px 16px",
  background: "#2563eb", color: "#fff", border: "none", borderRadius: 10,
  fontSize: 14, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap",
};
const newBtnBlocked: CSSProperties = { background: "#e2e8f0", color: "#94a3b8", cursor: "not-allowed" };
const tipStyle: CSSProperties = {
  position: "absolute", right: 0, top: "calc(100% + 8px)", width: 270, zIndex: 3,
  background: "rgba(17,24,39,.94)", color: "#f9fafb", fontSize: 12.5, lineHeight: 1.45,
  padding: "9px 11px", borderRadius: 8, fontWeight: 400, whiteSpace: "normal",
};
const sandboxBanner: CSSProperties = {
  display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 22, padding: "12px 16px",
  background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 12,
  fontSize: 13.5, lineHeight: 1.5,
};
const controls: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  gap: 12, margin: "22px 0 18px", flexWrap: "wrap",
};
const tabBtn: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 14px",
  background: "transparent", border: "1px solid transparent", borderRadius: 999,
  fontSize: 14, fontWeight: 600, color: "#64748b", cursor: "pointer",
};
const tabActive: CSSProperties = { background: "#fff", border: "1px solid #e2e8f0", color: "#1d4ed8" };
const countPill: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  minWidth: 20, height: 20, padding: "0 6px", borderRadius: 999,
  background: "#eef2f6", color: "#64748b", fontSize: 12, fontWeight: 700,
};
const search: CSSProperties = {
  flex: "1 1 240px", maxWidth: 320, padding: "9px 13px", border: "1px solid #e2e8f0",
  borderRadius: 10, fontSize: 14, color: "#0f172a", background: "#fff", boxSizing: "border-box",
};
const grid: CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 18,
};
const empty: CSSProperties = {
  textAlign: "center", padding: "60px 20px", background: "#fff", border: "1px dashed #dbe3ec", borderRadius: 16,
};
const emptyIcon: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 76, height: 76,
  borderRadius: 20, background: "#eff6ff",
};
const toastStyle: CSSProperties = {
  position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
  background: "#0f172a", color: "#fff", padding: "10px 18px", borderRadius: 10,
  fontSize: 14, boxShadow: "0 12px 30px rgba(15,23,42,.28)", zIndex: 50,
  pointerEvents: "none", // информативный снекбар не должен глотать клики под собой
};
