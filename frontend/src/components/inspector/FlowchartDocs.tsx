// Окно схемы логики (режим «Логика» DocOverlay): ОДНА схема узла (node_docs),
// выбранная на странице кликом. Стадии окна (прототип вьюера v2,
// docs/tasks/doc-viewer-v2.md):
//   • просмотр — рендер без кода, строка «Используется в процессах / Обращения»;
//     архитектору в шапке «Изменить ▾» (Вручную | Через ИИ-агента), у неописанной
//     схемы вместо рендера карточка с «Описать ▾»;
//   • «Вручную» — поля схемы (имя, вид, эндпоинт) и код с живым превью; «Отмена» и
//     «Сохранить» в шапке, «Удалить схему» в подвале. Сохранение ЯВНОЕ: одно
//     «Сохранить» — один PATCH под CAS и одно событие edit;
//   • «Через ИИ-агента» — шаги с промптом слева, панель пакета справа
//     (DocsAgentPanel в режиме «doc»); после «Применить» окно перечитывает схему.
// Новая схема («+ Добавить → Вручную» на странице) открывается сразу в «Вручную» и
// создаётся только по «Сохранить»: «Отмена» закрывает окно, ничего не оставив.
// Мутации репортятся наверх событием NodeDocEvent: страница освежает мету узла,
// процесс перечитывает шаги (истории на страницах нет).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { NodeDoc, NodeDocKind, NodeDocUpdate, NodeDocUsage, PromptVariant } from "../../types";
import { nodeDocsApi } from "../../api/nodes";
import { docsImportApi } from "../../api/docsImport";
import { isConflict } from "../../api/client";
import { limitMessage } from "../demo/demoLimits";
import type { LimitMessage } from "../demo/demoLimits";
import { LimitText } from "../demo/DemoLimitToast";
import FlowchartDoc from "./FlowchartDoc";
import FlowchartView, { StubCard } from "./FlowchartView";
import DocsAgentPanel from "../docsImport/DocsAgentPanel";
import { DocAgentSteps, DocHead, EditMenu, FlowGlyph, TwoStepDeleteButton } from "./docChrome";
import { noAutofill } from "../../ui/noAutofill";

// Событие мутации дока для истории/меты. before/after — полные доки: undo/redo
// делаются компенсациями PATCH/POST/DELETE без base_version (паттерн U24).
export type NodeDocEvent =
  | { type: "edit"; nodeId: string; before: NodeDoc; after: NodeDoc }
  | { type: "create"; nodeId: string; doc: NodeDoc }
  | { type: "delete"; nodeId: string; doc: NodeDoc };

interface Props {
  nodeId: string;
  nodeName: string;
  isArchitect: boolean;
  onDocEvent: (evt: NodeDocEvent) => void;
  onClose: () => void;
  // Крестик шапки: окно само решит, спросить ли «Закрыть без сохранения?».
  onRequestClose?: () => void;
  // Есть ли несохранённая правка «Вручную» — окно читает при закрытии.
  dirtyRef?: { current: boolean };
  // «+ Добавить → Вручную» со страницы: окно сразу в «Вручную» для новой схемы.
  createNew?: boolean;
  // Схема, по которой кликнули на странице (или в шаге процесса).
  initialDocId?: string;
  // Пакет агента применён — страница освежает мету узла (в историю не кладётся).
  onApplied?: () => void;
  // Переход в процесс из строки «Используется в процессах». Нет — имена текстом.
  onOpenProcess?: (processId: string) => void;
}

type Stage = "view" | "manual" | "agent";

// Черновик «Вручную»: поля схемы и её текст. Эндпоинт — строкой (пусто = нет).
interface Draft {
  name: string;
  kind: NodeDocKind;
  operation: string;
  content: string;
}

const KIND_LABEL: Record<NodeDocKind, string> = {
  operation: "Операция",
  worker: "Воркер",
};
const KIND_ORDER: NodeDocKind[] = ["operation", "worker"];

function freshName(docs: NodeDoc[]): string {
  const taken = new Set(docs.map((d) => d.name));
  if (!taken.has("Новая схема")) return "Новая схема";
  let i = 2;
  while (taken.has(`Новая схема ${i}`)) i++;
  return `Новая схема ${i}`;
}

const fromDoc = (d: NodeDoc): Draft => ({
  name: d.name, kind: d.kind, operation: d.operation ?? "", content: d.content,
});

const errorText = (e: unknown, fallback: string): string => (e instanceof Error ? e.message : fallback);

export default function FlowchartDocs({
  nodeId, nodeName, isArchitect, onDocEvent, onClose, onRequestClose, dirtyRef, createNew, initialDocId, onApplied, onOpenProcess,
}: Props) {
  const [docs, setDocs] = useState<NodeDoc[] | null>(null); // null — загрузка
  const [activeId, setActiveId] = useState<string | null>(initialDocId ?? null);
  const [stage, setStage] = useState<Stage>(createNew ? "manual" : "view");
  // Черновик «Вручную». null — правок ещё не было: поля берутся из схемы (или
  // дефолты новой) производно, без эффекта-зеркала.
  const [draft, setDraft] = useState<Draft | null>(null);
  // Ремаунт рендера/редактора после подтяжки свежего с сервера (409, агент).
  const [epoch, setEpoch] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // Демо-стенд: сохранение упёрлось в предел — красная плашка в подвале, черновик цел.
  const [limit, setLimit] = useState<LimitMessage | null>(null);
  const [saving, setSaving] = useState(false);
  const [showCode, setShowCode] = useState(false); // наблюдатель: «Показать код»
  const [usage, setUsage] = useState<NodeDocUsage[]>([]);

  const active = docs?.find((d) => d.id === activeId) ?? null;
  // Новая схема ещё не сохранена: в БД её нет, пока не нажато «Сохранить».
  const creating = !!createNew && activeId === null;
  const form: Draft | null =
    draft ??
    (active ? fromDoc(active) : creating && docs ? { name: freshName(docs), kind: "operation", operation: "", content: "" } : null);

  // Несохранённая правка: черновик «Вручную» отличается от схемы (у новой — любая
  // правка). Окну нужно знать это только в момент закрытия — отдаём через реф.
  const base = active ? fromDoc(active) : null;
  const dirty = stage === "manual" && draft !== null && (
    base === null
    || draft.name !== base.name || draft.kind !== base.kind
    || draft.operation !== base.operation || draft.content !== base.content
  );
  useEffect(() => { if (dirtyRef) dirtyRef.current = dirty; }, [dirty, dirtyRef]);

  useEffect(() => {
    let alive = true;
    nodeDocsApi.list(nodeId)
      .then((got) => { if (alive) setDocs(got); })
      .catch(() => { if (alive) { setDocs([]); setNotice("Не удалось загрузить схемы"); } });
    // Обратный индекс «используется в процессах»: украшение просмотра, а не его
    // опора — ошибка молча даёт пустую строку.
    nodeDocsApi.usage(nodeId)
      .then((u) => { if (alive) setUsage(u); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [nodeId]);

  function toView() {
    setStage("view");
    setDraft(null);
    setLimit(null);
  }

  function enterManual() {
    setDraft(null); // поля — свежие из схемы
    setNotice(null);
    setLimit(null);
    setStage("manual");
  }

  function enterAgent() {
    setNotice(null);
    setStage("agent");
  }

  function edit(patch: Partial<Draft>) {
    setDraft((prev) => {
      const base = prev ?? form;
      return base ? { ...base, ...patch } : prev;
    });
  }

  // 409 при записи: показываем detail, подтягиваем свежее и возвращаемся к
  // просмотру — как раньше, свежие данные вытесняют черновик.
  async function refetchAfterConflict(message: string) {
    setNotice(message);
    try {
      setDocs(await nodeDocsApi.list(nodeId));
    } catch { /* уровень догонит поллинг/ресинк */ }
    setEpoch((e) => e + 1);
    toView();
  }

  async function save() {
    if (!form || !docs || saving) return;
    // Пустое имя — не повод для отказа: остаётся прежнее (или дефолт новой).
    const name = form.name.trim() || (active ? active.name : freshName(docs));
    // Занятое имя ловим до запроса: 409 от сервера вернул бы окно к просмотру и
    // унёс бы черновик вместе с текстом схемы.
    if (docs.some((d) => d.id !== activeId && d.name === name)) {
      setNotice("Схема с таким именем уже есть у узла");
      return;
    }
    const operation = form.operation.trim();
    setSaving(true);
    setLimit(null);
    try {
      if (!active) {
        const doc = await nodeDocsApi.create(nodeId, {
          name,
          kind: form.kind,
          operation: form.kind === "operation" ? operation || null : null,
          content: form.content,
        });
        setDocs((prev) => [...(prev ?? []), doc]);
        setActiveId(doc.id);
        setNotice(null);
        onDocEvent({ type: "create", nodeId, doc });
        toView();
        return;
      }
      // Уезжает только изменённое. Эндпоинт у воркера не трогаем: поле скрыто, но
      // значение не стираем (как и раньше при смене вида).
      const fields: NodeDocUpdate = {};
      if (name !== active.name) fields.name = name;
      if (form.kind !== active.kind) fields.kind = form.kind;
      if (form.kind === "operation" && operation !== (active.operation ?? "")) fields.operation = operation || null;
      if (form.content !== active.content) fields.content = form.content;
      if (Object.keys(fields).length === 0) {
        setNotice(null);
        toView();
        return;
      }
      const saved = await nodeDocsApi.update(nodeId, active.id, { ...fields, base_version: active.version });
      setDocs((prev) => (prev ?? []).map((d) => (d.id === active.id ? saved : d)));
      setNotice(null);
      onDocEvent({ type: "edit", nodeId, before: active, after: saved });
      toView();
    } catch (e: unknown) {
      const refusal = limitMessage(e, "save");
      // Предел демо-стенда: черновик остаётся, его можно сократить и сохранить снова.
      if (refusal) setLimit(refusal);
      else if (isConflict(e) && active) await refetchAfterConflict(errorText(e, "Конфликт версий"));
      // Прочие отказы (и 409 создания — занятое имя) оставляют черновик на месте.
      else setNotice(errorText(e, "Схема не сохранена"));
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    setNotice(null);
    if (creating) onClose(); // новой схемы нет в БД — закрыть значит ничего не оставить
    else toView();
  }

  async function remove() {
    if (!active) return;
    try {
      await nodeDocsApi.delete(nodeId, active.id);
      onDocEvent({ type: "delete", nodeId, doc: active });
      onClose(); // окно одной схемы: показывать больше нечего
    } catch (e: unknown) {
      setNotice(errorText(e, "Схема не удалена"));
    }
  }

  // Промпт окна доков «по одной»: адрес — эндпоинт схемы, у воркера — её имя (имя
  // очереди; имена классов-обработчиков недоверенные, docs/plan-recon.md).
  function copyPrompt(variant: PromptVariant): Promise<void> {
    const target = active ? active.operation ?? active.name : "";
    return docsImportApi
      .prompt({ nodeId, include: "logic", lang: "ru", hints: "", target, variant })
      .then(({ prompt }) => navigator.clipboard.writeText(prompt));
  }

  async function afterAgent() {
    onApplied?.();
    try {
      setDocs(await nodeDocsApi.list(nodeId));
    } catch { /* уровень догонит поллинг/ресинк */ }
    setEpoch((e) => e + 1);
    setNotice(null);
    toView();
  }

  const described = active !== null && active.content.trim() !== "";
  const shownKind = stage === "manual" && form ? form.kind : active?.kind;

  // ── шапка ──
  const title = active ? (
    <><span>{nodeName} · </span>{active.name}</>
  ) : creating ? (
    <><span>{nodeName} · </span>Новая схема</>
  ) : (
    <>{nodeName} <span>· Логика</span></>
  );
  let actions: ReactNode = null;
  if (docs !== null && stage === "manual" && form && isArchitect) {
    actions = (
      <>
        <button type="button" className="doc-btn doc-btn--ghost" onClick={cancel}>Отмена</button>
        <button type="button" className="doc-btn doc-btn--primary" onClick={() => void save()} disabled={saving}>
          Сохранить
        </button>
      </>
    );
  } else if (stage === "agent" && active) {
    actions = <button type="button" className="doc-back" onClick={toView}>← К схеме</button>;
  } else if (stage === "view" && described && isArchitect) {
    actions = <EditMenu label="Изменить" onManual={enterManual} onAgent={enterAgent} />;
  } else if (stage === "view" && described && !isArchitect) {
    actions = (
      <button type="button" className="doc-codebtn" onClick={() => setShowCode((s) => !s)}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3" />
        </svg>
        {showCode ? "Скрыть код" : "Показать код"}
      </button>
    );
  }

  // ── тело ──
  let body: ReactNode;
  if (docs === null) {
    body = <div className="doc-pvnote" style={{ margin: "auto" }}>Загрузка схем…</div>;
  } else if (stage === "manual" && form && isArchitect) {
    body = (
      <div className="doc-flowwrap">
        <div className="doc-fields">
          <label className="doc-field doc-field--grow">
            Имя схемы
            <input {...noAutofill("flowchart-docs-1")} value={form.name} onChange={(e) => edit({ name: e.target.value })} />
          </label>
          <label className="doc-field" title="Обработчик операции или сценарий клиента / фоновый воркер">
            Вид
            <select value={form.kind} onChange={(e) => edit({ kind: e.target.value as NodeDocKind })}>
              {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </label>
          {form.kind === "operation" && (
            <label className="doc-field doc-field--grow" title="Эндпоинт OpenAPI-спеки узла, который обрабатывает эта схема">
              Эндпоинт
              <input {...noAutofill("flowchart-docs-2")} value={form.operation} onChange={(e) => edit({ operation: e.target.value })} placeholder="POST /orders" />
            </label>
          )}
        </div>
        <div className="doc-flowbody">
          <FlowchartDoc
            key={`edit:${activeId ?? "new"}:${epoch}`}
            initial={form.content}
            // Владелец схемы — он же владелец параметров конфигурации: пометка
            // «зависит от:» ищется только у него, и без узла плашка о ней промолчит.
            nodeId={nodeId}
            isArchitect
            showCode
            onDraft={(content) => edit({ content })}
          />
        </div>
      </div>
    );
  } else if (stage === "agent" && active && isArchitect) {
    body = (
      <div className="doc-agent">
        <div className="doc-agentleft">
          <DocAgentSteps target={active.operation ?? active.name} service={nodeName} copy={copyPrompt} />
        </div>
        <div className="doc-agentright">
          <DocsAgentPanel nodeId={nodeId} mode={{ kind: "doc", docName: active.name }} onApplied={() => void afterAgent()} />
        </div>
      </div>
    );
  } else if (active && described) {
    body = (
      <FlowchartView
        key={`view:${active.id}:${active.version}:${epoch}`}
        doc={active}
        nodeId={nodeId}
        showCode={showCode}
        usage={usage.filter((u) => u.doc_id === active.id)}
        onOpenProcess={onOpenProcess}
      />
    );
  } else if (active) {
    body = <StubCard kind={active.kind} canEdit={isArchitect} onManual={enterManual} onAgent={enterAgent} />;
  } else {
    body = (
      <div className="doc-pv">
        <div className="doc-pvcenter"><span className="doc-pvempty">Схема не найдена</span></div>
      </div>
    );
  }

  // ── подвал ──
  let foot: ReactNode = null;
  if (docs !== null && stage === "manual" && form && isArchitect) {
    foot = (
      <div className="doc-foot doc-foot--bar">
        {active && <TwoStepDeleteButton key={active.id} label="Удалить схему" onConfirm={() => void remove()} />}
        {limit
          ? <div className="doc-limit" role="alert"><LimitText message={limit} /></div>
          : <span>Превью обновляется на лету</span>}
      </div>
    );
  } else if (stage === "agent" && active && isArchitect) {
    foot = <div className="doc-foot">Схема не изменится, пока вы не нажмёте «Применить»</div>;
  }

  return (
    <>
      <DocHead
        glyph={<FlowGlyph />}
        title={title}
        tag={shownKind ? KIND_LABEL[shownKind] : "mermaid · flowchart"}
        actions={actions}
        onClose={onRequestClose ?? onClose}
      />
      {notice && <div className="doc-banner">{notice}</div>}
      <div className="doc-body">{body}</div>
      {foot}
    </>
  );
}
