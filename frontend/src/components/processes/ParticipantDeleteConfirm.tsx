import type { CSSProperties } from "react";
import { dangerBtn, secondaryBtn } from "../../ui/styles";

/**
 * Подтверждение удаления участника со схемы процесса. Презентационная карточка
 * (без Modal): рендерится в оверлее редактора, как остальные его подтверждения —
 * вкладывать второй <dialog> в модалку редактора нельзя. Текст и вид приведены к
 * единому виду с C4-модалкой NodeDeleteConfirm (заголовок, плашка-предупреждение,
 * список связей, кнопки «Да, удалить»/«Нет»). «Связи» здесь — сообщения процесса,
 * проведённые через этого участника: они исчезнут вместе с ним.
 */
export interface DelLink {
  id: string;
  label: string; // подпись сообщения (caption/технология/«сообщение»)
  dir: "к" | "от"; // участник — отправитель (к) или получатель (от)
  other: string; // имя другого конца
}

interface Props {
  name: string;
  links: DelLink[];
  deleting: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ParticipantDeleteConfirm({ name, links, deleting, error, onConfirm, onCancel }: Props) {
  return (
    <div style={card}>
      <div style={titleRow}>
        <span style={warnPlaque} aria-hidden>{WARN_ICON}</span>
        <h3 style={title}>Вы уверены, что хотите удалить «{name}»?</h3>
      </div>
      {links.length > 0 && (
        <>
          <p style={lead}>Его связи будут удалены вместе с ним:</p>
          <div style={edgeBox}>
            <ul style={edgeList}>
              {links.map((l) => (
                <li key={l.id} style={{ marginBottom: 4 }}>
                  «{l.label}» {l.dir} {l.other}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
      {error && <p style={errText}>{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button onClick={onConfirm} disabled={deleting} style={dangerBtn}>
          {deleting ? "Удаление..." : "Да, удалить"}
        </button>
        <button onClick={onCancel} disabled={deleting} style={secondaryBtn}>
          Нет
        </button>
      </div>
    </div>
  );
}

// Знак-предупреждение (тот же, что в NodeDeleteConfirm).
const WARN_ICON = (
  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 4 L21.5 20 H2.5 Z" />
    <path d="M12 10 V14.5" />
    <circle cx="12" cy="17.5" r="0.6" fill="currentColor" stroke="none" />
  </svg>
);

const card: CSSProperties = {
  width: 440,
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 13,
  boxShadow: "0 20px 56px rgba(15,23,42,.24)",
  padding: 22,
};
const titleRow: CSSProperties = { display: "flex", alignItems: "center", gap: 12, marginBottom: 14 };
const warnPlaque: CSSProperties = {
  flexShrink: 0, width: 36, height: 36, borderRadius: 10,
  background: "#fee2e2", color: "#dc2626",
  display: "inline-flex", alignItems: "center", justifyContent: "center",
};
const title: CSSProperties = { margin: 0, fontSize: 17, fontWeight: 700, color: "#1e293b", lineHeight: 1.3 };
const lead: CSSProperties = { color: "#475569", margin: "0 0 8px", fontSize: 14 };
const edgeBox: CSSProperties = {
  background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10,
  padding: "10px 12px", marginBottom: 4,
};
const edgeList: CSSProperties = { margin: 0, paddingLeft: 18, color: "#475569", fontSize: 14, lineHeight: 1.6 };
const errText: CSSProperties = { color: "#dc2626", margin: "8px 0", fontSize: 13 };
