import { useState } from "react";
import type { CSSProperties } from "react";
import type { DeletionSnapshot, Edge, EdgeUpdate } from "../types";
import { edgesApi } from "../api/nodes";
import NodeSearchPicker from "./NodeSearchPicker";
import Modal from "../ui/Modal";
import { labelStyle, input, primaryBtn, secondaryBtn, dangerBtnSoft } from "../ui/styles";

interface Props {
  edge: Edge;
  // РЕАЛЬНЫЕ концы связи (original_*), а не их проекция на уровень: на верхнем
  // уровне дочерний узел сворачивается в контейнер, но модалка обязана показывать
  // и править настоящий узел-конец, иначе правка любого поля затирала бы концы
  // спроецированными значениями.
  sourceId: string;
  targetId: string;
  sourceLabel: string;
  targetLabel: string;
  isArchitect: boolean;
  onClose: () => void;
  // snapshot — снимок связи, снятый ПЕРЕД удалением (для отката удаления через Undo).
  onDeleted: (id: string, snapshot: DeletionSnapshot) => void;
  // undoPayload/redoPayload — обратимая правка полей для Undo: undoPayload возвращает
  // прежние значения (включая концы и хэндлы), redoPayload повторяет правку.
  onSaved: (edge: Edge, undoPayload: EdgeUpdate, redoPayload: EdgeUpdate) => void;
}

export default function EdgeDetailModal({
  edge,
  sourceId: initialSourceId,
  targetId: initialTargetId,
  sourceLabel,
  targetLabel,
  isArchitect,
  onClose,
  onDeleted,
  onSaved,
}: Props) {
  const [editing, setEditing] = useState(false);
  // Локальные значения отображаемых полей (обновляются после сохранения)
  const [labelText, setLabelText] = useState(edge.label ?? "");
  const [technology, setTechnology] = useState(edge.technology ?? "");
  // Концы связи: id для сохранения + подписи для отображения. Стартуют с РЕАЛЬНЫХ
  // концов (original_*), поэтому сохранение без правки пикеров идемпотентно.
  const [sourceId, setSourceId] = useState(initialSourceId);
  const [targetId, setTargetId] = useState(initialTargetId);
  const [srcLabel, setSrcLabel] = useState(sourceLabel);
  const [tgtLabel, setTgtLabel] = useState(targetLabel);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setError(null);
    try {
      // Снимок снимаем ДО удаления — после каскада восстанавливать будет нечего.
      const snapshot = await edgesApi.deletionSnapshot(edge.id);
      await edgesApi.delete(edge.id);
      onDeleted(edge.id, snapshot);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка удаления");
    } finally {
      setDeleting(false);
    }
  }

  async function handleSave() {
    if (!sourceId || !targetId) {
      setError("Выберите исходный и целевой объекты");
      return;
    }
    if (sourceId === targetId) {
      setError("Объект не может ссылаться сам на себя");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // redoPayload — ровно то, что отправляем сейчас (повтор правки воспроизводит и
      // авто-сброс хэндлов при смене концов на бэке). undoPayload возвращает прежние
      // значения, ЯВНО передавая исходные хэндлы (иначе при возврате концов бэк их
      // обнулит). Концы берём реальные (initial*), не спроецированные.
      const redoPayload: EdgeUpdate = {
        label: labelText || null,
        technology: technology || null,
        source_id: sourceId,
        target_id: targetId,
      };
      const undoPayload: EdgeUpdate = {
        label: edge.label ?? null,
        technology: edge.technology ?? null,
        source_id: initialSourceId,
        target_id: initialTargetId,
        source_handle: edge.source_handle ?? null,
        target_handle: edge.target_handle ?? null,
      };
      const updated = await edgesApi.update(edge.id, redoPayload);
      onSaved(updated, undoPayload, redoPayload);
      // После сохранения закрываем модалку и возвращаемся прямо на схему (как и крестик),
      // а не в предыдущий поповер детализации.
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={onClose} boxStyle={{ width: 400 }}>
      <h2 style={{ margin: "0 0 16px" }}>{editing ? "Редактирование связи" : "Связь"}</h2>

        {editing ? (
          <>
            <label style={labelStyle}>Откуда *</label>
            <NodeSearchPicker
              value={sourceId}
              initialLabel={srcLabel}
              onChange={(id, lbl) => { setSourceId(id); if (lbl != null) setSrcLabel(lbl); }}
            />
            <label style={labelStyle}>Куда *</label>
            <NodeSearchPicker
              value={targetId}
              initialLabel={tgtLabel}
              onChange={(id, lbl) => { setTargetId(id); if (lbl != null) setTgtLabel(lbl); }}
            />
            <label style={labelStyle}>Описание</label>
            <input
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              placeholder="запрос, событие..."
              style={input}
            />
            <label style={labelStyle}>Технология</label>
            <input
              value={technology}
              onChange={(e) => setTechnology(e.target.value)}
              placeholder="REST, gRPC, Kafka..."
              style={input}
            />
          </>
        ) : (
          <>
            <div style={row}>
              <span style={label}>Откуда</span>
              <span style={value}>{srcLabel}</span>
            </div>
            <div style={row}>
              <span style={label}>Куда</span>
              <span style={value}>{tgtLabel}</span>
            </div>
            {labelText && (
              <div style={row}>
                <span style={label}>Описание</span>
                <span style={value}>{labelText}</span>
              </div>
            )}
            {technology && (
              <div style={row}>
                <span style={label}>Технология</span>
                <span style={value}>{technology}</span>
              </div>
            )}
          </>
        )}

        {error && <p style={{ color: "#dc2626", margin: "8px 0 0" }}>{error}</p>}

        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          {editing ? (
            <button onClick={handleSave} disabled={saving} style={primaryBtn}>
              {saving ? "Сохранение..." : "Сохранить"}
            </button>
          ) : isArchitect ? (
            <>
              <button onClick={() => setEditing(true)} style={primaryBtn}>
                Редактировать
              </button>
              <button onClick={handleDelete} disabled={deleting} style={dangerBtnSoft}>
                {deleting ? "Удаление..." : "Удалить связь"}
              </button>
            </>
          ) : (
            <button onClick={onClose} style={secondaryBtn}>Закрыть</button>
          )}
        </div>
    </Modal>
  );
}

const row: CSSProperties = {
  display: "flex",
  gap: 12,
  marginBottom: 10,
  fontSize: 14,
};
const label: CSSProperties = {
  width: 90,
  color: "#6b7280",
  fontWeight: 600,
  flexShrink: 0,
};
const value: CSSProperties = {
  color: "#111827",
};
