import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { ImportPreviewOut, Project, TemplateOut } from "../../types";
import { projectsApi } from "../../api/projects";
import Modal from "../../ui/Modal";
import { input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";
import C4Preview from "./C4Preview";
import ImportPane from "./ImportPane";
import "./createProject.css";

/**
 * Создание проекта — двухпанельная витрина: слева способ старта (Пустой / Шаблон /
 * Копия / Импорт) со списком вариантов и полями имени/описания, справа живое
 * превью выбранного шаблона (C4Preview 1:1 с холстом) либо панель импорта YAML
 * (несколько документов-чипов + живая сводка dry-run с отчётом слияния —
 * ImportPane). Открывается из лендинга и из дропдауна шапки — компонент один,
 * без редиректов. Успех → onCreated(id).
 */

interface Props {
  // активные проекты — источник для режима «копия»
  projects: Project[];
  onClose: () => void;
  onCreated: (id: string) => void;
}

type StartMode = "blank" | "template" | "copy" | "import";

// Линейные SVG-глифы шаблонов (currentColor, без эмодзи), по id из каталога.
function TemplateGlyph({ id, size = 18 }: { id: string; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (id) {
    case "monolith": // стопка
      return (<svg {...p}><rect x="6" y="3.5" width="12" height="17" rx="2" /><path d="M6 9h12M6 14.5h12" /></svg>);
    case "webapp": // окно-браузер
      return (<svg {...p}><rect x="3" y="4.5" width="18" height="14" rx="2" /><path d="M3 9h18M8 18.5v2M16 18.5v2M6 21h12" /></svg>);
    case "microservices": // сетка 2×2
      return (<svg {...p}><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></svg>);
    case "eventdriven": // волны
      return (<svg {...p}><circle cx="12" cy="12" r="2.4" /><path d="M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16" /></svg>);
    case "serverless": // молния
      return (<svg {...p}><path d="M13 2.5 4.5 13.5H11l-1.5 8L20 9.5h-7z" /></svg>);
    case "cqrs": // две встречные стрелки
      return (<svg {...p}><path d="M4 8h11l-3-3M4 8l3 3M20 16H9l3-3M20 16l-3 3" /></svg>);
    default:
      return (<svg {...p}><rect x="4" y="4" width="16" height="16" rx="2" /></svg>);
  }
}

export default function CreateProjectDialog({ projects, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<StartMode>("template");
  const [templates, setTemplates] = useState<TemplateOut[] | null>(null); // null = грузится
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(projects[0]?.id ?? null);
  // Документы импорта (мульти-репо: по YAML на репозиторий). Каждое изменение —
  // новый массив, поэтому актуальность сводки проверяется по ссылке (forDocs).
  const [docs, setDocs] = useState<string[]>([""]);
  // Сводка dry-run привязана к документам, для которых получена: устаревший
  // ответ не показываем и не засчитываем в готовность кнопки.
  const [importSummary, setImportSummary] = useState<{ forDocs: string[]; res: ImportPreviewOut } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Загрузка каталога шаблонов (легитимный эффект). По умолчанию выбран webapp,
  // иначе первый из ответа.
  useEffect(() => {
    projectsApi.templates().then(
      (list) => {
        setTemplates(list);
        setTemplateId((cur) => cur ?? (list.find((t) => t.id === "webapp") ?? list[0])?.id ?? null);
      },
      (e: unknown) => {
        setTemplates([]);
        setError(e instanceof Error ? e.message : "Не удалось загрузить шаблоны");
      },
    );
  }, []);

  // Живая сводка импорта: дебаунс 500мс → dry-run (все непустые документы);
  // устаревшие ответы отбрасываются (alive-флаг в cleanup). Пустые документы
  // сводку не запрашивают — она скрыта по несовпадению forDocs, синхронного
  // сброса стейта в эффекте нет.
  useEffect(() => {
    if (mode !== "import") return;
    const forDocs = docs;
    const texts = forDocs.filter((d) => d.trim());
    if (texts.length === 0) return;
    let alive = true;
    const t = setTimeout(() => {
      projectsApi.importPreview(texts).then(
        (res) => { if (alive) setImportSummary({ forDocs, res }); },
        (e: unknown) => {
          if (!alive) return;
          const msg = e instanceof Error ? e.message : "Не удалось проверить YAML";
          setImportSummary({ forDocs, res: {
            ok: false, errors: [msg], node_count: 0, edge_count: 0, roots: [],
            files: texts.length, merged_count: 0, merged: [], conflicts: [], warnings: [], dropped_edges: 0,
          } });
        },
      );
    }, 500);
    return () => { alive = false; clearTimeout(t); };
  }, [docs, mode]);

  const tpl = templates?.find((t) => t.id === templateId) ?? null;
  const source = projects.find((p) => p.id === sourceId) ?? null;
  const summary = importSummary && importSummary.forDocs === docs && docs.some((d) => d.trim())
    ? importSummary.res
    : null;

  const canSubmit =
    name.trim().length > 0 &&
    !busy &&
    !(mode === "template" && !templateId) &&
    !(mode === "copy" && !sourceId) &&
    !(mode === "import" && !summary?.ok);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const start =
      mode === "template" ? `template:${templateId}` :
      mode === "copy" ? `copy:${sourceId}` :
      mode === "import" ? "import" : "blank";
    try {
      const created = await projectsApi.create({
        name: name.trim(),
        description: description.trim() || null,
        start,
        import_yaml: null,
        import_yamls: mode === "import" ? docs.filter((d) => d.trim()) : null,
      });
      onCreated(created.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать проект");
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} boxStyle={{ width: 904, maxHeight: "90vh", padding: 0, overflow: "hidden" }}>
      <div style={root}>
        <h3 style={title}>Новый проект</h3>

        <div style={body}>
          {/* ── Левая колонка: способ старта + список + имя/описание ── */}
          <div style={leftCol}>
            <div style={{ display: "flex", gap: 8 }}>
              <SegBtn label="Пустой" on={mode === "blank"} onClick={() => setMode("blank")} />
              <SegBtn label="Шаблон" on={mode === "template"} onClick={() => setMode("template")} />
              <SegBtn
                label="Копия"
                on={mode === "copy"}
                disabled={projects.length === 0}
                onClick={() => projects.length && setMode("copy")}
              />
              <SegBtn label="Импорт" on={mode === "import"} onClick={() => setMode("import")} />
            </div>

            <div style={listArea}>
              {mode === "template" && (
                templates === null ? (
                  <>
                    <div className="cp-skel" style={{ height: 34, marginBottom: 6 }} />
                    <div className="cp-skel" style={{ height: 34, marginBottom: 6 }} />
                    <div className="cp-skel" style={{ height: 34 }} />
                  </>
                ) : (
                  templates.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      className={`cp-row${t.id === templateId ? " cp-row--on" : ""}`}
                      onClick={() => setTemplateId(t.id)}
                    >
                      <span style={glyphBox}><TemplateGlyph id={t.id} /></span>
                      <span style={{ fontWeight: 600 }}>{t.name}</span>
                    </button>
                  ))
                )
              )}

              {mode === "copy" &&
                projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={`cp-row${p.id === sourceId ? " cp-row--on" : ""}`}
                    onClick={() => setSourceId(p.id)}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.name}
                      </span>
                      <span style={{ fontSize: 12, color: "#64748b" }}>
                        {p.object_count} объектов · {p.edge_count} связей
                      </span>
                    </span>
                  </button>
                ))}

              {mode === "import" && (
                <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: "#64748b" }}>
                  Формат — тот же YAML, что выдаёт «Экспорт». Файлов может быть
                  несколько (например, по одному на репозиторий системы) — они
                  сольются автоматически, сводка справа покажет склейку,
                  конфликты и подозрения.
                </p>
              )}
            </div>

            <div>
              <label style={labelStyle}>Название</label>
              <input
                data-autofocus
                style={input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Например, «Платёжная платформа»"
                onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
              />
              <label style={labelStyle}>Описание <span style={{ color: "#94a3b8", fontWeight: 400 }}>(необязательно)</span></label>
              <textarea
                style={{ ...input, minHeight: 52, resize: "none", marginBottom: 0 }}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Коротко о схеме"
              />
            </div>
          </div>

          {/* ── Правая колонка: живое превью выбранного варианта ── */}
          <div style={rightCol}>
            {mode === "template" && (
              templates === null || !tpl ? (
                <div className="cp-skel" style={{ height: 280 }} />
              ) : (
                <>
                  <C4Preview template={tpl} height={280} showLabels />
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>{tpl.name}</div>
                    <p style={blurbStyle}>{tpl.blurb}</p>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {tpl.techs.map((tech) => (
                        <span key={tech} style={techChip}>{tech}</span>
                      ))}
                    </div>
                  </div>
                </>
              )
            )}

            {mode === "blank" && (
              <>
                <div style={emptyFrame}>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#475569" }}>Пустая схема</div>
                    <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>начните с чистого листа</div>
                  </div>
                </div>
                <p style={blurbStyle}>Проект откроется с пустым холстом.</p>
              </>
            )}

            {mode === "copy" && source && (
              <>
                <div style={emptyFrame}>
                  <div style={{ textAlign: "center", padding: "0 24px" }}>
                    <div style={{ fontWeight: 700, fontSize: 15, color: "#475569" }}>{source.name}</div>
                    <div style={{ fontSize: 13, color: "#94a3b8", marginTop: 4 }}>
                      {source.object_count} объектов · {source.edge_count} связей
                    </div>
                  </div>
                </div>
                <p style={blurbStyle}>Точная копия схемы «{source.name}» со всеми узлами и связями.</p>
              </>
            )}

            {mode === "import" && (
              <ImportPane docs={docs} onDocs={setDocs} summary={summary} />
            )}
          </div>
        </div>

        <div style={footer}>
          {error && <span style={{ flex: 1, color: "#dc2626", fontSize: 13, alignSelf: "center" }}>{error}</span>}
          <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
          <button
            style={{ ...primaryBtn, whiteSpace: "nowrap", opacity: canSubmit ? 1 : 0.55 }}
            disabled={!canSubmit}
            onClick={submit}
          >
            {busy ? "Создание…" : "Создать проект"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SegBtn({ label, on, disabled, onClick }: {
  label: string; on: boolean; disabled?: boolean; onClick: () => void;
}) {
  return (
    <button type="button" className={`cp-seg${on ? " cp-seg--on" : ""}`} disabled={disabled} onClick={onClick}>
      {label}
    </button>
  );
}

// Корень несёт колонки и ограничение высоты (maxHeight на <dialog> задаёт бокс,
// но внутренние скроллы работают от этого же лимита на контенте).
const root: CSSProperties = { display: "flex", flexDirection: "column", maxHeight: "90vh" };
const title: CSSProperties = { margin: 0, padding: "20px 22px 0", fontSize: 18, fontWeight: 700, color: "#0f172a" };
const body: CSSProperties = { display: "flex", gap: 22, padding: 22, height: 560, minHeight: 0 };
const leftCol: CSSProperties = { width: 326, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12, minHeight: 0 };
const listArea: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 };
const rightCol: CSSProperties = { flex: 1, minWidth: 0, overflowY: "auto" };
const glyphBox: CSSProperties = {
  width: 30, height: 30, flexShrink: 0, display: "inline-flex", alignItems: "center",
  justifyContent: "center", color: "#64748b",
};
const blurbStyle: CSSProperties = { margin: "8px 0 12px", fontSize: 13.5, lineHeight: 1.55, color: "#475569" };
const techChip: CSSProperties = {
  padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
  background: "#f1f5f9", color: "#475569", border: "1px solid #e2e8f0",
};
const emptyFrame: CSSProperties = {
  height: 280, display: "flex", alignItems: "center", justifyContent: "center",
  borderRadius: 10, border: "1px solid #eef2f6",
  background: "radial-gradient(circle, #d8e0ea 1px, transparent 1px) 0 0 / 16px 16px, #f8fafc",
};
const footer: CSSProperties = {
  display: "flex", justifyContent: "flex-end", gap: 8,
  padding: "14px 22px 16px", borderTop: "1px solid #eef2f6",
};
