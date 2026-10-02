import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Project } from "../../types";
import SchemaPreview from "./SchemaPreview";

/**
 * Карточка проекта на лендинге: превью схемы, имя и описание, кто и когда менял,
 * меню ⋯. Меню — редактору и владельцу: «Открыть» и «Доступ» обоим, управление
 * проектом (редактировать, архив, восстановить, удалить) — только владельцу.
 * Читателю состав участников не показываем, а без «Доступа» в меню остался бы один
 * пункт «Открыть» — поэтому у читателя меню ⋯ нет вовсе (и меток роли тоже нет).
 * Гостю демо-стенда «Доступ» не показываем (canShare=false): делиться ему не с кем.
 */
export default function ProjectCard({
  project, archivedTab, canShare = true, updaterLabel, onOpen, onAccess, onEdit, onArchive,
  onRestore, onDelete,
}: {
  project: Project;
  archivedTab: boolean;
  canShare?: boolean;
  // Подпись «кто менял» вместо логина (гость видит себя «Гостем», а не guest-…).
  updaterLabel?: string;
  onOpen: () => void;
  onAccess: () => void;
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
        {project.my_role !== "reader" && <CardMenu
          isOwner={project.my_role === "owner"}
          archivedTab={archivedTab}
          canShare={canShare}
          onOpen={onOpen}
          onAccess={onAccess}
          onEdit={onEdit}
          onArchive={onArchive}
          onRestore={onRestore}
          onDelete={onDelete}
        />}
      </div>
      <button style={cardBody} onClick={onOpen}>
        <div style={cardName}>{project.name}</div>
        <div style={cardDesc}>{project.description || "Без описания"}</div>
      </button>
      <div style={cardFooter}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span style={miniAvatar}>{initials(updaterLabel ?? project.updated_by)}</span>
          <span style={editorName}>{updaterLabel ?? project.updated_by ?? "—"}</span>
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
  isOwner, archivedTab, canShare, onOpen, onAccess, onEdit, onArchive, onRestore, onDelete,
}: {
  isOwner: boolean;
  archivedTab: boolean;
  canShare: boolean;
  onOpen: () => void;
  onAccess: () => void;
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
  const item = (label: string, fn: () => void, danger = false): ReactNode => (
    <MenuItem label={label} danger={danger} onClick={() => { setOpen(false); fn(); }} />
  );
  return (
    <div ref={ref} style={{ position: "absolute", top: 8, right: 8 }}>
      <button style={dotsBtn} onClick={() => setOpen((o) => !o)} aria-label="Меню проекта" aria-haspopup="menu" aria-expanded={open}>⋯</button>
      {open && (
        <div style={cardMenu} role="menu">
          {item("Открыть", onOpen)}
          {canShare && item("Доступ", onAccess)}
          {isOwner && item("Редактировать", onEdit)}
          {isOwner && (archivedTab ? (
            <>
              {item("Восстановить", onRestore)}
              {item("Удалить навсегда", onDelete, true)}
            </>
          ) : (
            item("Архивировать", onArchive)
          ))}
        </div>
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
