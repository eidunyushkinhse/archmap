// Окно «Зафиксировать версию» (docs/tasks/doc-versions.md §7; редизайн, фаза 9ж — каркас
// окна нового языка ds-win, ui/ds.css): первым абзацем перечень того, что войдёт в версию
// («Изменения с v3: …»; у первой версии абзаца нет), строка «Комментарий» с полем,
// «Зафиксировать» первой, «Отмена» за ней.
// Комментарий обязателен — по нему версию потом ищут (номер релиза или задачи), поэтому
// пустой не отправляется вовсе. Поле однострочное: комментарий — короткая метка, и Enter
// подтверждает окно (Modal onSubmit), как в прототипе.
import { useState } from "react";
import type { ReactNode } from "react";
import Modal from "../../../ui/Modal";
import { CloseIcon } from "../../../ui/icons";
import { noAutofill } from "../../../ui/noAutofill";
import { loadErrorText } from "../../../ui/loadErrorText";
import { limitMessage } from "../../demo/demoLimits";
import { LimitText } from "../../demo/DemoLimitToast";
import { versionsApi } from "../../../api/versions";
import "../../../ui/ds.css";
import "./versions.css";

interface Props {
  nodeId: string | null;
  // «Изменения с v3: …» — та же фраза, что в строке состояния списка версий; null у
  // первой версии (перечислять не с чем).
  lead: string | null;
  onClose: () => void;
  // Версия записана: окно версий перечитывает список и закрывает это окно.
  onDone: () => void;
}

export default function FixVersionDialog({ nodeId, lead, onClose, onDone }: Props) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>(null);
  const canSubmit = comment.trim() !== "" && !busy;

  function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    versionsApi.create(nodeId, comment.trim()).then(onDone, (e: unknown) => {
      // Предел демо — тем же видом, что в прочих окнах (жирное начало + текст сервера);
      // прочий отказ (пустой после обрезки, слишком длинный) — текстом сервера.
      const limit = limitMessage(e, "save");
      setError(limit ? <LimitText message={limit} /> : loadErrorText(e));
      setBusy(false);
    });
  }

  return (
    <Modal onClose={onClose} onSubmit={submit} boxStyle={{ width: 480, padding: 0 }}>
      <div className="ds ds-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">Зафиксировать версию</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="ds-win-body">
          {lead && <p className="vp-fix-lead">{lead}</p>}
          <dl className="ds-props">
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor="version-comment">Комментарий</label></dt>
              <dd className="ds-prop-value">
                <input
                  {...noAutofill("version-comment")}
                  id="version-comment"
                  type="text"
                  className="ds-input"
                  data-autofocus
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="номер версии, релиза или задачи"
                />
              </dd>
            </div>
          </dl>
        </div>
        <div className="ds-win-foot">
          {error && <p className="ds-danger ds-win-err" role="alert">{error}</p>}
          <button type="button" className="ds-btn ds-btn--primary" disabled={!canSubmit} onClick={submit}>
            {busy ? "Фиксируем" : "Зафиксировать"}
          </button>
          <button type="button" className="ds-btn" disabled={busy} onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}
