import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { DeletionSnapshot, Edge, EdgeUpdate, Node } from "../types";
import { canHaveChildren } from "../types";
import { edgesApi, nodesApi } from "../api/nodes";
import NodeSearchPicker from "./NodeSearchPicker";
import SyncSegmented from "./SyncSegmented";
import Modal from "../ui/Modal";
import { useScrollEdges } from "../ui/useScrollEdges";
import { CloseIcon } from "../ui/icons";
import { ShapeGlyph } from "./nodeTree.shared";
import { labelStyle, input, primaryBtn, secondaryBtn, dangerBtnSoft } from "../ui/styles";
import "../ui/modalShell.css";
import "./NodeTreePanel.css";

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
  // Тип связи (бизнес-процессы): null у легаси-связей трактуем как синхронную.
  const [isSync, setIsSync] = useState(edge.is_synchronous ?? true);
  // Концы связи: id для сохранения + подписи для отображения. Стартуют с РЕАЛЬНЫХ
  // концов (original_*), поэтому сохранение без правки пикеров идемпотентно.
  const [sourceId, setSourceId] = useState(initialSourceId);
  const [targetId, setTargetId] = useState(initialTargetId);
  const [srcLabel, setSrcLabel] = useState(sourceLabel);
  const [tgtLabel, setTgtLabel] = useState(targetLabel);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Узлы-концы (read-only): нужны только чтобы нарисовать глиф формы рядом с
  // «Откуда/Куда» (тот же ShapeGlyph, что в дереве). Контракт связи не несёт формы
  // концов, поэтому подтягиваем сами по id. Пока не загрузились — глиф просто не
  // рисуем (имя видно сразу). Концы off-level, поэтому именно фетч по id.
  const [ends, setEnds] = useState<Record<string, Node>>({});
  useEffect(() => {
    let alive = true;
    const ids = Array.from(new Set([sourceId, targetId].filter(Boolean)));
    Promise.all(ids.map((id) => nodesApi.get(id).catch(() => null))).then((nodes) => {
      if (!alive) return;
      setEnds((prev) => {
        const next = { ...prev };
        for (const n of nodes) if (n) next[n.id] = n;
        return next;
      });
    });
    return () => { alive = false; };
  }, [sourceId, targetId]);

  // Глиф формы конца по id (контейнер — «коробка с крышкой», как в дереве).
  const endGlyph = (id: string): ReactNode => {
    const n = ends[id];
    if (!n) return null;
    return <ShapeGlyph container={canHaveChildren(n.shape) && !!n.has_children} shape={n.shape} />;
  };

  // Липкая шапка/футер: общий каркас и хук теней краёв (как в NodeModal).
  // resubKey=editing — у просмотра и правки разные футеры, маяки перемонтируются.
  const { atTop, atBottom, topRef, bottomRef } = useScrollEdges(editing);
  const headerClass = `modal-header${atTop ? " modal-header--at-top" : ""}`;
  const footerClass = `modal-footer${atBottom ? " modal-footer--at-bottom" : ""}`;

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
        is_synchronous: isSync,
      };
      const undoPayload: EdgeUpdate = {
        label: edge.label ?? null,
        technology: edge.technology ?? null,
        source_id: initialSourceId,
        target_id: initialTargetId,
        source_handle: edge.source_handle ?? null,
        target_handle: edge.target_handle ?? null,
        is_synchronous: edge.is_synchronous ?? null,
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
    <Modal onClose={onClose} closeButton={false} boxStyle={{ width: 420, maxHeight: "90vh", overflowY: "auto" }}>
      {/* Липкая шапка со своим SVG-крестиком (дефолтный уехал бы при прокрутке). */}
      <div ref={topRef} style={{ height: 1 }} aria-hidden />
      <div className={headerClass}>
        <h2>{editing ? "Редактирование связи" : "Связь"}</h2>
        <button onClick={onClose} className="modal-close" aria-label="Закрыть">
          <CloseIcon />
        </button>
      </div>

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
          <label style={labelStyle}>Тип связи</label>
          <SyncSegmented value={isSync} onChange={setIsSync} disabled={saving} />
        </>
      ) : (
        // Строки метаданных «свойство → значение» с иконками-термами (как metaList
        // в NodeModal). «Откуда/Куда» — объекты: рядом со значением глиф формы конца.
        <dl style={metaList}>
          <div style={metaRow}>
            <dt style={metaTerm}>
              <span style={metaIconWrap}>{EDGE_META_ICON.source}</span>
              Откуда
            </dt>
            <dd style={metaValue}>
              {endGlyph(sourceId)}
              <span style={endName}>{srcLabel}</span>
            </dd>
          </div>
          <div style={metaRow}>
            <dt style={metaTerm}>
              <span style={metaIconWrap}>{EDGE_META_ICON.target}</span>
              Куда
            </dt>
            <dd style={metaValue}>
              {endGlyph(targetId)}
              <span style={endName}>{tgtLabel}</span>
            </dd>
          </div>
          {labelText && (
            <div style={metaRow}>
              <dt style={metaTerm}>
                <span style={metaIconWrap}>{EDGE_META_ICON.desc}</span>
                Описание
              </dt>
              <dd style={metaValue}>{labelText}</dd>
            </div>
          )}
          {technology && (
            <div style={metaRow}>
              <dt style={metaTerm}>
                <span style={metaIconWrap}>{EDGE_META_ICON.tech}</span>
                Технология
              </dt>
              <dd style={metaValue}>{technology}</dd>
            </div>
          )}
          <div style={metaRow}>
            <dt style={metaTerm}>
              <span style={metaIconWrap}>{EDGE_META_ICON.sync}</span>
              Тип связи
            </dt>
            <dd style={metaValue}>{isSync ? "Синхронная" : "Асинхронная"}</dd>
          </div>
        </dl>
      )}

      {/* Липкая полоса действий: текст ошибки над кнопками. */}
      <div ref={bottomRef} style={{ height: 1 }} aria-hidden />
      <div className={footerClass}>
        {error && <p style={errText}>{error}</p>}
        <div style={{ display: "flex", gap: 8 }}>
          {editing ? (
            <>
              <button onClick={handleSave} disabled={saving} style={primaryBtn}>
                {saving ? "Сохранение..." : "Сохранить"}
              </button>
              <button onClick={() => setEditing(false)} style={secondaryBtn}>
                Отмена
              </button>
            </>
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
      </div>
    </Modal>
  );
}

// --- Строки метаданных связи (режим просмотра) ---

// Базовые атрибуты линейных иконок-термов (16×16, как metaSvg в NodeModal).
const metaSvg = {
  width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
  stroke: "currentColor", strokeWidth: 1.5,
  strokeLinecap: "round", strokeLinejoin: "round",
} as const;

// Откуда — узел со стрелкой наружу; Куда — стрелка в узел; Описание — метка-ярлык;
// Технология — </> (идентична иконке технологии узла в NodeModal).
const EDGE_META_ICON: Record<"source" | "target" | "desc" | "tech" | "sync", ReactNode> = {
  source: <svg {...metaSvg}><circle cx="3.5" cy="8" r="2.25" /><path d="M6 8h7" /><path d="M10.5 5.4 13.2 8l-2.7 2.6" /></svg>,
  target: <svg {...metaSvg}><path d="M2.8 8h7" /><path d="M7.3 5.4 10 8l-2.7 2.6" /><circle cx="12.5" cy="8" r="2.25" /></svg>,
  desc: <svg {...metaSvg}><path d="M8.4 2.6 13 7.2a1.3 1.3 0 0 1 0 1.8l-3.9 3.9a1.3 1.3 0 0 1-1.8 0L2.7 8.3V4a1.3 1.3 0 0 1 1.3-1.3Z" /><circle cx="5.6" cy="5.5" r=".9" fill="currentColor" stroke="none" /></svg>,
  tech: <svg {...metaSvg}><path d="M6 5.4 3 8l3 2.6" /><path d="M10 5.4 13 8l-3 2.6" /></svg>,
  sync: <svg {...metaSvg}><path d="M3 6h8l-2-2" /><path d="M13 10H5l2 2" /></svg>,
};

const metaList: CSSProperties = { margin: 0, borderTop: "1px solid #eef2f6" };
const metaRow: CSSProperties = {
  display: "flex", gap: 12, alignItems: "center",
  padding: "11px 0", borderBottom: "1px solid #eef2f6",
};
const metaTerm: CSSProperties = {
  display: "flex", alignItems: "center", gap: 9,
  width: 132, flexShrink: 0, color: "#64748b", fontSize: 13, fontWeight: 600,
};
const metaIconWrap: CSSProperties = { display: "flex", color: "#94a3b8" };
// NB: metaValue на <dd> — обязательно margin:0, иначе UA-стиль margin-inline-start
// сдвинет значение.
const metaValue: CSSProperties = {
  margin: 0, display: "flex", alignItems: "center", gap: 8,
  fontSize: 14, color: "#0f172a", minWidth: 0,
};
// Значение-объект («Откуда/Куда») — жирнее; длинное имя усекаем многоточием.
const endName: CSSProperties = {
  fontWeight: 600, minWidth: 0,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};
const errText: CSSProperties = { color: "#dc2626", fontSize: 13, margin: "0 0 8px" };
