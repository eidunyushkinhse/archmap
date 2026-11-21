import { useState } from "react";
import { codeChangesApi } from "../../api/codeChanges";
import type { CodeChangeAlert } from "../../types";
import SyncRepoModal from "../docsImport/SyncRepoModal";
import { changeLine, namesHint } from "./codeChangeText";
import "../../ui/ds.css";
import "./codeChangeNotice.css";

/**
 * Плашка «Документацию пора обновить» под шапкой проекта (замечание владельца 2026-11-21,
 * пункт 3): CI сообщил о слиянии в репозиторий, из которого объекты проекта
 * (backend/app/code_changes.py). Данные — тот же класс рекомендаций (code_changes), что
 * в панели «Рекомендации». Строка на репозиторий; «Обновить из кода» открывает то же окно,
 * что меню проекта, и после применения с объектами репозитория строка гаснет сама;
 * «Документация актуальна» снимает её вручную (обновлять было нечего).
 * Вид — новый язык (редизайн, фаза 5): тихая полоса, стили в codeChangeNotice.css; корень —
 * область .ds (окно обновления из кода внутри неё держит прежние метрики, ui/tokens.css).
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
    <div className="ds ccn" role="status" data-testid="code-change-notice">
      <div className="ccn-rows">
        {changes.map((c) => (
          <div key={c.id} className="ccn-row">
            <span title={namesHint(c)}>{changeLine(c)}</span>
            <button type="button" className="ccn-dismiss" disabled={busy === c.id} onClick={() => void dismiss(c.id)}>
              Документация актуальна
            </button>
          </div>
        ))}
        {error && <span className="ccn-err">{error}</span>}
      </div>
      <button type="button" className="ds-btn" onClick={() => setSyncOpen(true)}>Обновить из кода</button>
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
