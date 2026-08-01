// Наполнитель режима «Логика» DocOverlay: коллекция именованных схем узла
// (node_docs) вместо прежнего единственного flowchart. Сам фетчит полные доки
// при открытии (в Node.docs едет только мета), держит активный док и панель
// управления (переключатель, имя, вид, операция, создать/удалить); тело —
// прежний FlowchartDoc активного дока. Мутации уходят в API сразу (PATCH — под
// optimistic CAS) и репортятся наверх событием NodeDocEvent: MapEditorPage кладёт
// компенсации в Undo/Redo и освежает мету узла в стейте уровня.
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeDoc, NodeDocKind } from "../../types";
import { nodeDocsApi } from "../../api/nodes";
import { isConflict } from "../../api/client";
import FlowchartDoc from "./FlowchartDoc";

// Событие мутации дока для истории/меты. before/after — полные доки: undo/redo
// делаются компенсациями PATCH/POST/DELETE без base_version (паттерн U24).
export type NodeDocEvent =
  | { type: "edit"; nodeId: string; before: NodeDoc; after: NodeDoc }
  | { type: "create"; nodeId: string; doc: NodeDoc }
  | { type: "delete"; nodeId: string; doc: NodeDoc };

interface Props {
  nodeId: string;
  isArchitect: boolean;
  showCode: boolean; // наблюдатель нажал «Показать код» (пробрасывается в FlowchartDoc)
  onDocEvent: (evt: NodeDocEvent) => void;
  // «+ Добавить» со страницы узла: создать новую схему сразу при открытии
  autoCreate?: boolean;
  // Клик по конкретной схеме в секции «Логика»: открыть её активной
  initialDocId?: string;
}

const KIND_LABEL: Record<NodeDocKind, string> = {
  overview: "Обзор",
  operation: "Операция",
  worker: "Воркер",
};
const KIND_ORDER: NodeDocKind[] = ["overview", "operation", "worker"];

// Стабильный порядок списка: обзорные → операции → воркеры, внутри — по имени.
function sortDocs(docs: NodeDoc[]): NodeDoc[] {
  return [...docs].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
}

function freshName(docs: NodeDoc[]): string {
  const taken = new Set(docs.map((d) => d.name));
  if (!taken.has("Новая схема")) return "Новая схема";
  let i = 2;
  while (taken.has(`Новая схема ${i}`)) i++;
  return `Новая схема ${i}`;
}

export default function FlowchartDocs({ nodeId, isArchitect, showCode, onDocEvent, autoCreate, initialDocId }: Props) {
  const [docs, setDocs] = useState<NodeDoc[] | null>(null); // null — загрузка
  const [activeId, setActiveId] = useState<string | null>(null);
  // Ремаунт FlowchartDoc/полей меты после подтяжки свежего с сервера (409):
  // version в key не годится — свой успешный save тоже бампает её и сбрасывал бы
  // стейт редактора на каждом сохранении.
  const [epoch, setEpoch] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const sorted = useMemo(() => (docs === null ? [] : sortDocs(docs)), [docs]);
  const active = sorted.find((d) => d.id === activeId) ?? sorted[0] ?? null;

  useEffect(() => {
    let alive = true;
    nodeDocsApi.list(nodeId)
      .then((got) => {
        if (!alive) return;
        setDocs(got);
        // Активная: запрошенная со страницы (если есть), иначе первая по сортировке
        const target = initialDocId && got.some((d) => d.id === initialDocId)
          ? initialDocId
          : sortDocs(got)[0]?.id ?? null;
        setActiveId(target);
      })
      .catch(() => { if (alive) { setDocs([]); setNotice("Не удалось загрузить схемы"); } });
    return () => { alive = false; };
    // initialDocId — разовый курсор открытия, намеренно вне зависимостей
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  // «+ Добавить» со страницы: создать схему сразу, как загрузился список
  const autoCreatedRef = useRef(false);
  useEffect(() => {
    if (!autoCreate || !isArchitect || docs === null || autoCreatedRef.current) return;
    autoCreatedRef.current = true;
    void createDoc();
    // createDoc стабильна по смыслу (замыкание на sorted), повтор — под запретом ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCreate, isArchitect, docs]);

  async function refetchAfterConflict(message: string) {
    setNotice(message);
    try {
      const got = await nodeDocsApi.list(nodeId);
      setDocs(got);
      setEpoch((e) => e + 1);
    } catch { /* уровень догонит поллинг/ресинк */ }
  }

  // Единая правка: PATCH под CAS от версии последнего известного состояния.
  // 409 (чужая сессия ИЛИ занятое имя) — показываем detail и подтягиваем свежее.
  async function patch(doc: NodeDoc, fields: Partial<Pick<NodeDoc, "name" | "kind" | "operation" | "content">>) {
    try {
      const saved = await nodeDocsApi.update(nodeId, doc.id, { ...fields, base_version: doc.version });
      setDocs((prev) => (prev ?? []).map((d) => (d.id === doc.id ? saved : d)));
      setNotice(null);
      onDocEvent({ type: "edit", nodeId, before: doc, after: saved });
    } catch (e: unknown) {
      if (isConflict(e)) void refetchAfterConflict(e instanceof Error ? e.message : "Конфликт версий");
    }
  }

  async function createDoc() {
    try {
      const doc = await nodeDocsApi.create(nodeId, { name: freshName(sorted), kind: "overview", operation: null, content: "" });
      setDocs((prev) => [...(prev ?? []), doc]);
      setActiveId(doc.id);
      setNotice(null);
      onDocEvent({ type: "create", nodeId, doc });
    } catch (e: unknown) {
      if (isConflict(e)) void refetchAfterConflict(e instanceof Error ? e.message : "Конфликт");
    }
  }

  async function deleteActive() {
    if (!active) return;
    try {
      await nodeDocsApi.delete(nodeId, active.id);
      setDocs((prev) => (prev ?? []).filter((d) => d.id !== active.id));
      setActiveId(null); // упадёт на первый по сортировке
      onDocEvent({ type: "delete", nodeId, doc: active });
    } catch { /* удалено другой сессией — ресинк догонит */ }
  }

  if (docs === null) {
    return <div className="doc-pvnote" style={{ margin: "auto" }}>Загрузка схем…</div>;
  }

  return (
    <div className="doc-flowwrap">
      {(sorted.length > 0 || isArchitect) && (
        <div className="doc-sub">
          {sorted.length > 0 && (
            <select
              className="doc-subsel"
              value={active?.id ?? ""}
              onChange={(e) => setActiveId(e.target.value)}
              aria-label="Схема"
            >
              {sorted.map((d) => (
                <option key={d.id} value={d.id}>
                  {KIND_LABEL[d.kind]} · {d.name}
                </option>
              ))}
            </select>
          )}
          {isArchitect && active && (
            <>
              {/* Черновики имени/операции живут в DocMetaFields: key ремаунтит их на
                  смену дока/подтяжку свежего — без зеркалирования пропсов эффектом */}
              <DocMetaFields
                key={`${active.id}:${epoch}`}
                doc={active}
                onPatch={(fields) => void patch(active, fields)}
              />
              <span className="doc-subgap" />
              <button type="button" className="doc-subbtn" onClick={() => void createDoc()}>+ Схема</button>
              <TwoStepDeleteButton key={`del:${active.id}`} onConfirm={() => void deleteActive()} />
            </>
          )}
          {isArchitect && !active && (
            <>
              <span className="doc-subgap" />
              <button type="button" className="doc-subbtn" onClick={() => void createDoc()}>+ Схема</button>
            </>
          )}
        </div>
      )}
      {notice && <div className="doc-banner">{notice}</div>}
      <div className="doc-flowbody">
        {active ? (
          <FlowchartDoc
            key={`${active.id}:${epoch}`}
            initial={active.content}
            isArchitect={isArchitect}
            showCode={showCode}
            onCommit={(v) => { if (v !== active.content) void patch(active, { content: v }); }}
          />
        ) : (
          <div className="doc-pv">
            <div className="doc-pvcenter">
              <span className="doc-pvempty">
                {isArchitect ? "Нет схем — создайте первую кнопкой «+ Схема»" : "Нет схем"}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Поля меты активного дока (имя, вид, операция). Черновики — локальный стейт,
// инициализируются пропсом при маунте: родитель ремаунтит по key на смену
// дока/подтяжку свежего (паттерн key-remount вместо эффекта-зеркала).
// Объявлен на верхнем уровне модуля: inline-объявление ремаунтилось бы каждый рендер.
function DocMetaFields({
  doc,
  onPatch,
}: {
  doc: NodeDoc;
  onPatch: (fields: Partial<Pick<NodeDoc, "name" | "kind" | "operation">>) => void;
}) {
  const [nameDraft, setNameDraft] = useState(doc.name);
  const [opDraft, setOpDraft] = useState(doc.operation ?? "");

  const commitName = () => {
    const t = nameDraft.trim();
    if (!t || t === doc.name) { setNameDraft(doc.name); return; }
    onPatch({ name: t });
  };
  const commitOperation = () => {
    const t = opDraft.trim();
    if (t === (doc.operation ?? "")) return;
    onPatch({ operation: t || null });
  };

  return (
    <>
      <input
        className="doc-subfield doc-subfield--name"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        onBlur={commitName}
        aria-label="Имя схемы"
      />
      <select
        className="doc-subsel"
        value={doc.kind}
        onChange={(e) => onPatch({ kind: e.target.value as NodeDocKind })}
        aria-label="Вид схемы"
        title="Обзор / обработчик API-операции / фоновый воркер"
      >
        {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
      </select>
      {doc.kind === "operation" && (
        <input
          className="doc-subfield"
          value={opDraft}
          onChange={(e) => setOpDraft(e.target.value)}
          onBlur={commitOperation}
          placeholder="POST /orders"
          aria-label="Операция OpenAPI"
          title="Операция OpenAPI-спеки узла, которую обрабатывает эта схема"
        />
      )}
    </>
  );
}

// Двухшаговое удаление вместо вложенной модалки подтверждения: <dialog> внутри
// <dialog> нельзя (cancel бубблит — ui/Modal). Второй клик по той же кнопке
// подтверждает, увод фокуса — отменяет; key у родителя сбрасывает шаг на смену дока.
function TwoStepDeleteButton({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={"doc-subbtn" + (armed ? " doc-subbtn--danger" : "")}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? "Точно удалить?" : "Удалить"}
    </button>
  );
}
