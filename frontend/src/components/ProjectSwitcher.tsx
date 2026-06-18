import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { projectsApi } from "../api/projects";
import type { Project } from "../types";
import { ChevronIcon, PlusIcon } from "../ui/icons";
import CreateProjectDialog from "./project/CreateProjectDialog";

/**
 * Свитчер проектов в шапке схемы: имя текущего проекта + дропдаун (поиск ТОЛЬКО по
 * имени, без превью/меты), выбор переключает проект, футер — «+ Новый проект» и
 * «Все проекты». Закрытие по клику вне / Escape.
 */

interface Props {
  projectId: string;
  isArchitect: boolean;
  onAllProjects: () => void;
  onSwitchProject: (id: string) => void;
}

export default function ProjectSwitcher({ projectId, isArchitect, onAllProjects, onSwitchProject }: Props) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  // Активные проекты — для имени текущего и списка дропдауна. Тянем при первом
  // открытии и держим (смена проекта ремаунтит шапку целиком).
  useEffect(() => {
    void projectsApi.list(false).then(setProjects).catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  const current = projects.find((p) => p.id === projectId);
  const q = query.trim().toLowerCase();
  const filtered = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button style={trigger} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}>
        <LayersIcon />
        <span style={triggerName}>{current?.name ?? "Проект"}</span>
        <ChevronIcon />
      </button>

      {open && (
        <div style={menu} role="menu">
          <input
            autoFocus
            style={searchInput}
            placeholder="Поиск проекта"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div style={listWrap}>
            {filtered.length === 0 && <div style={{ padding: "10px 12px", color: "#94a3b8", fontSize: 13 }}>Ничего не найдено</div>}
            {filtered.map((p) => (
              <SwitcherItem
                key={p.id}
                name={p.name}
                current={p.id === projectId}
                onClick={() => { setOpen(false); if (p.id !== projectId) onSwitchProject(p.id); }}
              />
            ))}
          </div>
          <div style={footer}>
            {isArchitect && (
              <button style={footerBtn} onClick={() => { setOpen(false); setCreating(true); }}>
                <PlusIcon size={15} /> Новый проект
              </button>
            )}
            <button style={footerBtn} onClick={() => { setOpen(false); onAllProjects(); }}>
              Все проекты
            </button>
          </div>
        </div>
      )}

      {creating && (
        <CreateProjectDialog
          projects={projects}
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); onSwitchProject(id); }}
        />
      )}
    </div>
  );
}

// Пункт списка проектов с подсветкой по ховеру (как в ⋯-меню карточки). Текущий
// проект подсвечен синим всегда и помечен галочкой; остальные сереют под курсором.
function SwitcherItem({ name, current, onClick }: { name: string; current: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const bg = current ? "#eff6ff" : hover ? "#f1f5f9" : "transparent";
  return (
    <button
      style={{ ...itemRow, background: bg, color: current ? "#1d4ed8" : "#1e293b" }}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="menuitem"
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      {current && <CheckIcon />}
    </button>
  );
}

const LayersIcon = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 2 2 7l10 5 10-5-10-5Z" />
    <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
  </svg>
);

const CheckIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const trigger: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7, padding: "6px 10px",
  background: "#fff", border: "1px solid #e2e8f0", borderRadius: 9, cursor: "pointer",
  color: "#334155", fontSize: 14, fontWeight: 600, maxWidth: 240,
};
const triggerName: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 160 };
const menu: CSSProperties = {
  position: "absolute", top: "calc(100% + 8px)", left: 0, width: 280, background: "#fff",
  border: "1px solid #e2e8f0", borderRadius: 12, boxShadow: "0 16px 40px rgba(15,23,42,.16)",
  padding: 8, zIndex: 30,
};
const searchInput: CSSProperties = {
  width: "100%", padding: "8px 10px", border: "1px solid #e2e8f0", borderRadius: 8,
  fontSize: 13.5, boxSizing: "border-box", marginBottom: 6, color: "#0f172a",
};
const listWrap: CSSProperties = { maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 };
const itemRow: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8,
  width: "100%", padding: "8px 10px", border: "none", borderRadius: 8, cursor: "pointer",
  fontSize: 13.5, fontWeight: 600, textAlign: "left",
};
const footer: CSSProperties = {
  display: "flex", gap: 6, marginTop: 6, paddingTop: 8, borderTop: "1px solid #eef2f6",
};
const footerBtn: CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6, flex: 1, justifyContent: "center",
  padding: "8px 10px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8,
  cursor: "pointer", fontSize: 13, fontWeight: 600, color: "#334155",
};
