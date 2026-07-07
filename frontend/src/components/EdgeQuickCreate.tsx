import { useState } from "react";
import type { Edge, EdgeCreate } from "../types";
import { edgesApi } from "../api/nodes";
import Modal from "../ui/Modal";
import { labelStyle, input, primaryBtn, secondaryBtn } from "../ui/styles";

interface Props {
  // Концы связи уже определены жестом: стрелку протянули от source к target (хэндл).
  // Хэндлы из жеста связь больше не несёт (R3): геометрия живёт на пучке display-пары
  // в view_layout — их сохраняет TreePage (persistGestureHandles) после onCreated.
  sourceId: string;
  targetId: string;
  sourceLabel: string;
  targetLabel: string;
  onClose: () => void;
  // created — созданная связь (для отката создания через Undo в TreePage).
  onCreated: (created: Edge) => void;
}

/**
 * Упрощённый поповер создания прямой связи: концы уже заданы жестом (протянули
 * стрелку от узла на хэндл другого), остаётся заполнить «Описание» и «Технологию».
 * Связь создаётся по «Создать»; отмена/крестик закрывают без создания (раньше
 * связь появлялась сразу пустой — заполнить можно было только через редактирование).
 */
export default function EdgeQuickCreate({
  sourceId, targetId, sourceLabel, targetLabel, onClose, onCreated,
}: Props) {
  const [label, setLabel] = useState("");
  const [technology, setTechnology] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    setSaving(true);
    setError(null);
    try {
      const data: EdgeCreate = {
        source_id: sourceId,
        target_id: targetId,
        label: label || null,
        technology: technology || null,
      };
      const created = await edgesApi.create(data);
      onCreated(created);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка создания связи");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} boxStyle={{ width: 400 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 18, color: "#1e293b" }}>Новая связь</h2>
      <p style={{ margin: "0 0 16px", color: "#475569", fontSize: 14 }}>
        {sourceLabel} → {targetLabel}
      </p>

      <label style={labelStyle}>Описание</label>
      <input
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="запрос, событие..."
        style={input}
        data-autofocus
      />
      <label style={labelStyle}>Технология</label>
      <input
        value={technology}
        onChange={(e) => setTechnology(e.target.value)}
        placeholder="REST, gRPC, Kafka..."
        style={input}
      />

      {error && <p style={{ color: "#dc2626", margin: "8px 0", fontSize: 13 }}>{error}</p>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button onClick={handleCreate} disabled={saving} style={primaryBtn}>
          {saving ? "Создание..." : "Создать связь"}
        </button>
        <button onClick={onClose} style={secondaryBtn}>Отмена</button>
      </div>
    </Modal>
  );
}
