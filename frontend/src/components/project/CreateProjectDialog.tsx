import { useState } from "react";
import type { CSSProperties } from "react";
import type { Project } from "../../types";
import { projectsApi } from "../../api/projects";
import Modal from "../../ui/Modal";
import { input, labelStyle, primaryBtn, secondaryBtn } from "../../ui/styles";

/**
 * Создание проекта: имя (обязательно) + описание + «Начать с» (пустой / шаблон /
 * копия). Для шаблона — выбор пресета, для копии — выбор исходного проекта.
 * Успех → onCreated(новый id) (родитель переключается в новый проект).
 */

interface Props {
  // активные проекты — источник для режима «копия»
  projects: Project[];
  onClose: () => void;
  onCreated: (id: string) => void;
}

type StartMode = "blank" | "template" | "copy";

const TEMPLATES: { id: string; name: string; desc: string }[] = [
  { id: "microservices", name: "Микросервисы", desc: "Шлюз, сервисы, БД, брокер" },
  { id: "c4", name: "C4: система", desc: "Пользователь, веб, API, БД" },
  { id: "eventdriven", name: "События", desc: "Продюсер, брокер, консьюмеры" },
];

export default function CreateProjectDialog({ projects, onClose, onCreated }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<StartMode>("blank");
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const [sourceId, setSourceId] = useState<string | null>(projects[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && !busy && !(mode === "copy" && !sourceId);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const start =
      mode === "template" ? `template:${templateId}` : mode === "copy" ? `copy:${sourceId}` : "blank";
    try {
      const created = await projectsApi.create({
        name: name.trim(),
        description: description.trim() || null,
        start,
      });
      onCreated(created.id);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось создать проект");
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} boxStyle={{ width: 520, maxHeight: "86vh", overflowY: "auto", padding: 24 }}>
      <h3 style={title}>Новый проект</h3>

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
        style={{ ...input, minHeight: 60, resize: "vertical" }}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Коротко о схеме"
      />

      <label style={{ ...labelStyle, marginTop: 6 }}>Начать с</label>
      <div style={cardRow}>
        <StartCard active={mode === "blank"} title="Пустой" desc="Чистая схема" onClick={() => setMode("blank")} />
        <StartCard active={mode === "template"} title="Из шаблона" desc="Готовый каркас" onClick={() => setMode("template")} />
        <StartCard
          active={mode === "copy"}
          title="Копия проекта"
          desc={projects.length ? "Клон схемы" : "Нет проектов"}
          disabled={projects.length === 0}
          onClick={() => projects.length && setMode("copy")}
        />
      </div>

      {mode === "template" && (
        <div style={subList}>
          {TEMPLATES.map((t) => (
            <label key={t.id} style={radioRow}>
              <input
                type="radio"
                name="tpl"
                checked={templateId === t.id}
                onChange={() => setTemplateId(t.id)}
              />
              <span style={{ fontWeight: 600, color: "#1e293b" }}>{t.name}</span>
              <span style={{ color: "#94a3b8", fontSize: 12.5 }}>· {t.desc}</span>
            </label>
          ))}
        </div>
      )}

      {mode === "copy" && (
        <div style={subList}>
          {projects.map((p) => (
            <label key={p.id} style={radioRow}>
              <input
                type="radio"
                name="src"
                checked={sourceId === p.id}
                onChange={() => setSourceId(p.id)}
              />
              <span style={{ fontWeight: 600, color: "#1e293b" }}>{p.name}</span>
              <span style={{ color: "#94a3b8", fontSize: 12.5 }}>· {p.object_count} об.</span>
            </label>
          ))}
        </div>
      )}

      {error && <p style={{ color: "#dc2626", fontSize: 13, margin: "10px 0 0" }}>{error}</p>}

      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <button style={{ ...primaryBtn, opacity: canSubmit ? 1 : 0.55 }} disabled={!canSubmit} onClick={submit}>
          {busy ? "Создание…" : "Создать проект"}
        </button>
        <button style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}

function StartCard({
  active, title, desc, onClick, disabled,
}: { active: boolean; title: string; desc: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        ...startCard,
        borderColor: active ? "#2563eb" : "#e2e8f0",
        background: active ? "#eff6ff" : "#fff",
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span style={{ fontWeight: 700, fontSize: 13.5, color: active ? "#1d4ed8" : "#1e293b" }}>{title}</span>
      <span style={{ fontSize: 12, color: "#64748b" }}>{desc}</span>
    </button>
  );
}

const title: CSSProperties = { margin: "0 0 16px", fontSize: 18, fontWeight: 700, color: "#0f172a" };
const cardRow: CSSProperties = { display: "flex", gap: 8, marginBottom: 6 };
const startCard: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #e2e8f0",
  textAlign: "left",
};
const subList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginTop: 8,
  padding: "8px 10px",
  background: "#f8fafc",
  border: "1px solid #eef2f6",
  borderRadius: 10,
};
const radioRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 4px",
  cursor: "pointer",
  fontSize: 13.5,
};
