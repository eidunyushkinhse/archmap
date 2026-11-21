import { useState } from "react";
import type { CSSProperties } from "react";
import { codeChangesApi } from "../../api/codeChanges";
import type { CodeChangeAlert } from "../../types";
import SyncRepoModal from "../docsImport/SyncRepoModal";
import { changeLine, namesHint } from "./codeChangeText";

/**
 * Плашка «Документацию пора обновить» под шапкой проекта (замечание владельца 2026-11-21,
 * пункт 3): CI сообщил о слиянии в репозиторий, из которого объекты проекта
 * (backend/app/code_changes.py). Данные — тот же класс рекомендаций (code_changes), что
 * в панели «Рекомендации». Строка на репозиторий; «Обновить из кода» открывает то же окно,
 * что меню проекта, и после применения с объектами репозитория строка гаснет сама;
 * «Документация актуальна» снимает её вручную (обновлять было нечего).
 */

interface Props {
  projectId: string;
  changes: CodeChangeAlert[];
  /** Схема обновлена из кода: оболочка перечитывает дерево, страницу и рекомендации. */
  onSynced: () => void;
  /** Напоминание снято вручную: оболочка перечитывает рекомендации. */
  onDismissed: () => void;
}

export default function CodeChangeNotice({ projectId, changes, onSynced, onDismissed }: Props) {
  const [syncOpen, setSyncOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function dismiss(id: string) {
    setBusy(id);
    setError(null);
    try {
      await codeChangesApi.dismiss(id);
      onDismissed();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось снять напоминание");
    } finally {
      setBusy(null);
    }
  }

  if (changes.length === 0) return null;
  return (
    <div style={bar} role="status" data-testid="code-change-notice">
      <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
        {changes.map((c) => (
          <div key={c.id} style={row}>
            <span title={namesHint(c)}>{changeLine(c)}</span>
            <button style={linkBtn} disabled={busy === c.id} onClick={() => void dismiss(c.id)}>
              Документация актуальна
            </button>
          </div>
        ))}
        {error && <span style={errText}>{error}</span>}
      </div>
      <button style={primary} onClick={() => setSyncOpen(true)}>Обновить из кода</button>
      {syncOpen && (
        <SyncRepoModal
          projectId={projectId}
          onClose={() => setSyncOpen(false)}
          onApplied={() => onSynced()}
        />
      )}
    </div>
  );
}

const bar: CSSProperties = {
  display: "flex", alignItems: "center", gap: 12, padding: "8px 16px",
  borderBottom: "1px solid #fde68a", background: "#fffbeb", color: "#78350f", fontSize: 13.5,
};
const row: CSSProperties = { display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" };
const linkBtn: CSSProperties = {
  background: "none", border: "none", padding: 0, fontSize: 13, fontWeight: 600,
  color: "#92400e", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 2,
};
const primary: CSSProperties = {
  flex: "none", padding: "6px 12px", borderRadius: 8, border: "1px solid #f59e0b",
  background: "#fff", color: "#92400e", fontSize: 13, fontWeight: 600, cursor: "pointer",
};
const errText: CSSProperties = { color: "#b91c1c", fontSize: 12.5 };
