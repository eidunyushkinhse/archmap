import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { getUserRole } from "../api/auth";
import { projectsApi } from "../api/projects";
import type { Project } from "../types";
import CreateProjectDialog from "../components/project/CreateProjectDialog";
import EditProjectDialog from "../components/project/EditProjectDialog";
import { ArchiveDialog, DeleteForeverDialog, RestoreDialog } from "../components/project/ProjectDialogs";
import SchemaPreview from "../components/project/SchemaPreview";
import ProfileMenu from "../ui/ProfileMenu";
import { LogoMark, PlusIcon } from "../ui/icons";

/**
 * Лендинг «Проекты»: сетка карточек со схемой-превью, метаданными и меню ⋯.
 * Табы Активные/Архив, поиск, пустые состояния. Открытие проекта — клик по телу
 * карточки. Управление (создать/архив/восстановить/удалить) — только architect.
 */

interface Props {
  onOpenProject: (id: string) => void;
  onLogout: () => void;
}

type Tab = "active" | "archived";
type Dialog =
  | { kind: "create" }
  | { kind: "edit" | "archive" | "restore" | "delete"; project: Project }
  | null;

export default function ProjectsPage({ onOpenProject, onLogout }: Props) {
  const isArchitect = getUserRole() === "architect";
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
        <ProfileMenu role={isArchitect ? "Архитектор" : "Наблюдатель"} onLogout={onLogout} />
      </div>

      <div style={container}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <h1 style={h1}>Проекты</h1>
          </div>
          {isArchitect && (
            <button style={newBtn} onClick={() => setDialog({ kind: "create" })}>
              <PlusIcon /> Новый проект
            </button>
          )}
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
            isArchitect={isArchitect}
            onCreate={() => setDialog({ kind: "create" })}
          />
        ) : (
          <div style={grid}>
            {filtered.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                isArchitect={isArchitect}
                archivedTab={tab === "archived"}
                onOpen={() => onOpenProject(p.id)}
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

// ── Карточка проекта ──────────────────────────────────────────────────────────
function ProjectCard({
  project, isArchitect, archivedTab, onOpen, onEdit, onArchive, onRestore, onDelete,
}: {
  project: Project;
  isArchitect: boolean;
  archivedTab: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{ ...card, transform: hover ? "translateY(-2px)" : "none", boxShadow: hover ? "0 12px 28px rgba(15,23,42,.12)" : "0 1px 2px rgba(15,23,42,.06)" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ position: "relative" }}>
        <button style={cardPreviewBtn} onClick={onOpen} title="Открыть проект">
          <SchemaPreview preview={project.preview} />
        </button>
        {isArchitect && (
          <CardMenu archivedTab={archivedTab} onOpen={onOpen} onEdit={onEdit} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} />
        )}
      </div>
      <button style={cardBody} onClick={onOpen}>
        <div style={cardName}>{project.name}</div>
        <div style={cardDesc}>{project.description || "Без описания"}</div>
      </button>
      <div style={cardFooter}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span style={miniAvatar}>{initials(project.updated_by)}</span>
          <span style={editorName}>{project.updated_by ?? "—"}</span>
          <span style={{ color: "#cbd5e1" }}>·</span>
          <span style={{ color: "#94a3b8", whiteSpace: "nowrap" }}>{fmtDate(project.updated_at)}</span>
        </div>
        <span style={{ color: "#94a3b8", whiteSpace: "nowrap" }}>
          {project.object_count} об. · {project.edge_count} св.
        </span>
      </div>
    </div>
  );
}

function CardMenu({
  archivedTab, onOpen, onEdit, onArchive, onRestore, onDelete,
}: {
  archivedTab: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const item = (label: string, fn: () => void, danger = false): React.ReactNode => (
    <MenuItem label={label} danger={danger} onClick={() => { setOpen(false); fn(); }} />
  );
  return (
    <div ref={ref} style={{ position: "absolute", top: 8, right: 8 }}>
      <button style={dotsBtn} onClick={() => setOpen((o) => !o)} aria-label="Меню проекта" aria-haspopup="menu" aria-expanded={open}>⋯</button>
      {open && (
        <div style={cardMenu} role="menu">
          {item("Открыть", onOpen)}
          {item("Редактировать", onEdit)}
          {archivedTab ? (
            <>
              {item("Восстановить", onRestore)}
              {item("Удалить навсегда", onDelete, true)}
            </>
          ) : (
            item("Архивировать", onArchive)
          )}
        </div>
      )}
    </div>
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

// Пункт дропдауна ⋯ с подсветкой активной зоны по ховеру (инлайн-стили :hover не
// умеют — держим состояние). Danger-пункт («Удалить») подсвечивается красноватым.
function MenuItem({ label, danger, onClick }: { label: string; danger?: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      style={{
        ...menuItem,
        color: danger ? "#dc2626" : "#1e293b",
        background: hover ? (danger ? "#fef2f2" : "#f1f5f9") : "transparent",
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ ...tabBtn, ...(active ? tabActive : {}) }}>{children}</button>
  );
}

// ── Утилиты ───────────────────────────────────────────────────────────────────
function initials(name: string | null): string {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return s.toUpperCase();
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
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
const card: CSSProperties = {
  background: "#fff", border: "1px solid #e8edf3", borderRadius: 14, overflow: "hidden",
  transition: "transform .14s ease, box-shadow .14s ease", display: "flex", flexDirection: "column",
};
const cardPreviewBtn: CSSProperties = {
  display: "block", width: "100%", padding: 12, border: "none", background: "none", cursor: "pointer",
};
const dotsBtn: CSSProperties = {
  width: 30, height: 30, borderRadius: 8, border: "1px solid #e2e8f0", background: "rgba(255,255,255,.92)",
  color: "#475569", fontSize: 18, lineHeight: 1, cursor: "pointer", display: "flex",
  alignItems: "center", justifyContent: "center",
};
const cardMenu: CSSProperties = {
  position: "absolute", top: "calc(100% + 6px)", right: 0, width: 190, background: "#fff",
  border: "1px solid #e2e8f0", borderRadius: 10, boxShadow: "0 16px 40px rgba(15,23,42,.16)",
  padding: 6, zIndex: 5,
};
const menuItem: CSSProperties = {
  display: "block", width: "100%", textAlign: "left", padding: "8px 10px", background: "none",
  border: "none", borderRadius: 7, fontSize: 13.5, cursor: "pointer",
};
const cardBody: CSSProperties = {
  display: "block", width: "100%", textAlign: "left", padding: "2px 14px 10px",
  background: "none", border: "none", cursor: "pointer",
};
const cardName: CSSProperties = { fontSize: 15.5, fontWeight: 700, color: "#0f172a", marginBottom: 3 };
const cardDesc: CSSProperties = {
  fontSize: 13, color: "#64748b", lineHeight: 1.4, display: "-webkit-box",
  WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", minHeight: 36,
};
const cardFooter: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
  padding: "10px 14px", borderTop: "1px solid #f1f5f9", fontSize: 12, color: "#94a3b8",
};
const miniAvatar: CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center", width: 22, height: 22,
  flex: "none", borderRadius: "50%", background: "#eff6ff", color: "#1d4ed8", fontSize: 10, fontWeight: 700,
};
const editorName: CSSProperties = {
  color: "#475569", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 90,
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
