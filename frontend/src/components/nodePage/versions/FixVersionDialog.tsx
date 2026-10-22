// Окно «Зафиксировать версию» (docs/tasks/doc-versions.md §7): одна строка «объект ·
// изменения с vN: …», поле комментария, «Зафиксировать» слева, «Отмена» справа.
// Комментарий обязателен — по нему версию потом ищут (номер релиза или задачи), поэтому
// пустой не отправляется вовсе. Подтверждение с клавиатуры — Modal onSubmit (в
// многострочном поле — Ctrl/Cmd+Enter: Enter там перенос строки).
import { useState } from "react";
import type { ReactNode } from "react";
import Modal from "../../../ui/Modal";
import DialogTitle from "../../../ui/DialogTitle";
import { errText, input, labelStyle, primaryBtn, secondaryBtn } from "../../../ui/styles";
import { noAutofill } from "../../../ui/noAutofill";
import { loadErrorText } from "../../../ui/loadErrorText";
import { limitMessage } from "../../demo/demoLimits";
import { LimitText } from "../../demo/DemoLimitToast";
import { versionsApi } from "../../../api/versions";

interface Props {
  nodeId: string | null;
  // «Сервис заказов · изменения с v3: …» — та же строка, что над списком версий.
  lead: string;
  onClose: () => void;
  // Версия записана: панель перечитывает список и закрывает окно.
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
    <Modal onClose={onClose} onSubmit={submit} boxStyle={{ width: 480, padding: 24 }}>
      <DialogTitle lead={lead}>Зафиксировать версию</DialogTitle>
      <label style={labelStyle} htmlFor="version-comment">Комментарий — номер версии, релиза или задачи</label>
      <textarea
        {...noAutofill("version-comment")}
        id="version-comment"
        data-autofocus
        style={{ ...input, minHeight: 64, resize: "vertical", marginBottom: 0 }}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="orders 2.4 · ORD-430"
      />
      {error && <p style={errText} role="alert">{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
        <button type="button" style={primaryBtn} disabled={!canSubmit} onClick={submit}>
          {busy ? "Фиксация…" : "Зафиксировать"}
        </button>
        <button type="button" style={secondaryBtn} disabled={busy} onClick={onClose}>Отмена</button>
      </div>
    </Modal>
  );
}
