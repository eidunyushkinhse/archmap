// Холст процесса для режима «Процессы» — тело редактора и просмотрщика, поднятое с
// модалки (ProcessEditorModal / ProcessViewerModal ретайрятся). Один компонент на обе
// роли: тумблер «Редактировать/Готово» (только архитектор) переключает inline-правку.
// Движок (SequenceDiagram), композитор и вся механика — переиспользованы как есть
// (drag-to-connect, хэндл «себе», покраска по статусу узла). Бэкенд/модель не трогаем.
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import type { ComponentProps, CSSProperties, ReactNode } from "react";
import { processesApi } from "../../api/processes";
import type { FragmentKind, NodeStatus } from "../../types";
import MessageComposer from "../MessageComposer";
import DocOverlay from "../inspector/DocOverlay";
import { stepDoc } from "./stepDoc";
import MessageCard from "./MessageCard";
import ConfirmDialog from "../../ui/ConfirmDialog";
import ParticipantDeleteConfirm, { type DelLink } from "./ParticipantDeleteConfirm";
import ParticipantPicker from "./ParticipantPicker";
import { C4Glyph, IcoBrokenLink, IcoClose } from "./icons";
import { ViewHint } from "./SchemaViewChrome";
import ProcessToolbar from "./ProcessToolbar";
import SequenceDiagram from "./SequenceDiagram";
import { deriveActivations } from "./sequence/layout";
import { detailToSeq } from "./sequence/fromDetail";
import { BPT, BROKEN } from "./tokens";
import { useProcessDetail } from "./useProcessDetail";
import type { ProcessEditCtx } from "./editCtx";
import { fragmentEdits } from "./fragmentEdits";
import { messageEdits } from "./messageEdits";
import { participantEdits } from "./participantEdits";
import { useProcessHistory } from "./useProcessHistory";
import { useOverlayStack, type Overlay, type OverlayKind } from "./useOverlayStack";
import { readSchemaView, writeSchemaView, type SchemaView } from "../schemaView";
import "./processes.css";
import { noAutofill } from "../../ui/noAutofill";

interface Props {
  id: string;
  isArchitect: boolean;
  editing: boolean;
  onToggleEditing: (v: boolean) => void;
  // Дёргается после успешной мутации (число сообщений/статусы могли смениться) —
  // воркспейс обновляет список в рейле.
  onChanged: () => void;
  // Переход на страницу объекта с линии жизни участника (id — УЗЛА). Зеркало
  // обратного перехода со страницы объекта в процесс.
  onOpenNode?: (nodeId: string) => void;
  // Счётчик чужих правок (Д9): поллинг воркспейса заметил рост process_rev —
  // канвас перечитывает процесс. Растёт только на ЧУЖИЕ изменения.
  syncRev?: number;
}

export default function ProcessCanvas({ id, isArchitect, editing, onToggleEditing, onChanged, onOpenNode, syncRev }: Props) {
  const proc = useProcessDetail(id, onChanged, syncRev);
  const {
    detail, error, reload,
    msgById, fragById, partById, nodeOfPart, nextOrder,
  } = proc;
  // Куда можно завести сообщение — ключи «откуда>куда». Ответ БЭКА: проекция
  // концов связи через предков живёт там, и вторая реализация на клиенте
  // разошлась бы с валидатором. Обновляем, когда картина могла измениться:
  // вход в правку, закрытие композитора (там же переключают тип канала),
  // перезагрузка процесса.
  const [directions, setDirections] = useState<Set<string>>(new Set());
  // Режим выбора диапазона под фрагмент: выбран тип, ждём протягивания по сообщениям.
  const [fragSelect, setFragSelect] = useState<FragmentKind | null>(null);
  // Итог подхвата каналов — показываем строкой: молча подхватить и промолчать значит
  // скрыть, что часть шагов осталась сломанной.
  const [bindNote, setBindNote] = useState<string | null>(null);
  // Ревизия каталога схем карточки: правка в оверлее меняет имена/состав схем.
  const [docCatalogRev, setDocCatalogRev] = useState(0);
  // Окна поверх холста — одним стеком в порядке открытия (композитор, карточки шага,
  // ветки, фрагмента, подтверждения, привязка, панель участников, схема логики).
  // Провал из карточки шага в схему логики (У7) ложится выше карточки: закрывается
  // схема, карточка остаётся.
  const { stack: overlayStack, get: overlay, open: openOverlay, close: closeOverlay, update: updateOverlay } =
    useOverlayStack();
  // Вид схемы — общий с C4-схемой ключ ЭТОГО проекта (в другом проекте свой).
  const [view, setView] = useState<SchemaView>(readSchemaView);
  useEffect(() => { writeSchemaView(view); }, [view]);

  // Undo/Redo: каждая мутация регистрирует обратимую команду (компенсирующий вызов API).
  const hist = useProcessHistory(reload);
  const editCtx: ProcessEditCtx = {
    id, proc, hist, overlays: { open: openOverlay, close: closeOverlay, update: updateOverlay },
  };
  // Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) — только в режиме правки. Не перехватываем в полях.
  useEffect(() => {
    if (!editing) return;
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); hist.undo(); }
      else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); hist.redo(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hist, editing]);

  const seq = useMemo(() => (detail ? detailToSeq(detail) : null), [detail]);
  const activations = useMemo(() => (seq ? deriveActivations(seq.messages) : []), [seq]);
  const counts = useMemo<Record<NodeStatus, number>>(() => {
    const c: Record<NodeStatus, number> = { existing: 0, planned: 0, deprecated: 0 };
    // У непривязанного участника статуса нет — в бейдж вида он не попадает.
    if (detail) for (const p of detail.participants) if (p.status) c[p.status]++;
    return c;
  }, [detail]);
  const hasStatus = counts.planned + counts.deprecated > 0;
  // Сколько шагов кнопка «Восстановить связи» реально может починить: она ищет канал
  // ПОВИСШЕМУ шагу, поэтому считаем только их. Шаг, потерявший плечо (канал стал
  // асинхронным), тоже показан сломанным, но связь у него на месте — подхватывать
  // нечего, и попади он в счётчик, кнопка обещала бы починку, которой не умеет.
  // Самосообщения не попадают сами: у внутренней операции связи C4 не было.
  const danglingCount = useMemo(
    () => (detail ? detail.messages.filter((m) => m.invalid_reason === "edge_deleted").length : 0),
    [detail],
  );
  const delPart = overlay("delPart")?.part ?? null;
  const delLinks = useMemo((): DelLink[] => {
    if (!detail || !delPart) return [];
    return detail.messages
      .filter((m) => m.from_participant_id === delPart.id || m.to_participant_id === delPart.id)
      .map((m) => {
        const outgoing = m.from_participant_id === delPart.id;
        const other = outgoing ? m.to_participant_id : m.from_participant_id;
        return {
          id: m.id,
          label: m.caption || m.technology || "сообщение",
          dir: outgoing ? "к" : "от",
          other: partById[other]?.name ?? other,
        };
      });
  }, [detail, delPart, partById]);

  const {
    addParticipants, reorderParticipants, requestBind, bindParticipant, reattachChannels,
    requestRemoveParticipant, confirmRemoveParticipant,
  } = participantEdits(editCtx, setBindNote);

  // Перечитать карту направлений. Вне режима правки индикация не нужна — не ходим.
  const reloadDirections = useCallback(() => {
    if (!editing) return;
    processesApi
      .directions(id)
      .then((rows) => setDirections(new Set(rows.map((r) => `${r.from_id}>${r.to_id}`))))
      .catch(() => setDirections(new Set()));
  }, [editing, id]);

  useEffect(() => { reloadDirections(); }, [reloadDirections, detail]);

  // Закрыть окно — ровно то же, что его «Отмена» и клик по подложке; второй логики
  // закрытия не заводим. Композитор при закрытии перечитывает направления: в нём
  // переключают тип канала.
  const dismiss = useCallback((kind: OverlayKind) => {
    closeOverlay(kind);
    if (kind === "composer") reloadDirections();
  }, [closeOverlay, reloadDirections]);

  // Escape закрывает верхний оверлей — как все окна проекта (ui/Modal.tsx получает это
  // даром от нативного <dialog>). Здесь оверлеи — обычные div: вложенные <dialog> в
  // проекте запрещены (их cancel всплывает и гасит соседа), поэтому клавишу ловим сами.
  // ⚠️ Ведём себя ровно как <dialog>: закрываем и когда фокус в поле ввода — иначе
  // Escape не работал бы почти нигде, у всех карточек поле autoFocus. Исключение одно
  // и то же, что у браузера: во время IME-композиции Escape отменяет НАБОР и до окна
  // не доходит. С Ctrl+Z не спорим: там обработчик требует Ctrl/Cmd, здесь — нет.
  // Схема логики сверху — сама ui/Modal, и Escape принадлежит ей: несохранённая правка
  // спрашивает, прежде чем закрыться (решение 2026-09-29). Перехват здесь гасил её
  // cancel (preventDefault) и закрывал окно молча. Идущее удаление участника Escape не
  // бросает — как и клик по подложке.
  const topOverlay = overlayStack.at(-1) ?? null;
  useEffect(() => {
    if (!topOverlay || topOverlay.kind === "doc") return;
    const { kind } = topOverlay;
    const held = topOverlay.kind === "delPart" && topOverlay.busy;
    function onEsc(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.isComposing) return;
      e.preventDefault();
      if (!held) dismiss(kind);
    }
    document.addEventListener("keydown", onEsc);
    return () => document.removeEventListener("keydown", onEsc);
  }, [topOverlay, dismiss]);

  const { handleMessageAdded, createSelfMessage, saveCaption, linkDoc, setChannelSync, removeMessage, reorderMessages } =
    messageEdits(editCtx);
  const { createFragment, resizeFragment, patchBranches, moveBranch, saveBranch, removeFragment } =
    fragmentEdits(editCtx);

  // Одно окно стека. Закрытие любого — dismiss/closeOverlay его вида: «Отмена», клик по
  // подложке и Escape делают одно и то же.
  function renderOverlay(o: Overlay): ReactNode {
    switch (o.kind) {
      // Композитор сообщения — по центру видимой области.
      case "composer":
        if (!detail) return null;
        return (
          <>
            <div style={overlayDim} onClick={() => dismiss("composer")} />
            <div style={overlayCenter}>
              <MessageComposer
                processId={id}
                participants={detail.participants}
                fromNode={o.from}
                toNode={o.to}
                defaultOrder={nextOrder}
                onClose={() => dismiss("composer")}
                onAdded={handleMessageAdded}
              />
            </div>
          </>
        );
      // Самосообщение: ввод подписи внутренней операции.
      case "self":
        if (!detail) return null;
        return (
          <PromptCard
            title={`Рефлексивное сообщение · ${partById[o.pid]?.name ?? o.pid}`}
            hint="Действие участника над самим собой (без связи в C4) — внутренняя операция."
            autofillKey="process-canvas-1"
            value={o.caption}
            onChange={(caption) => updateOverlay("self", (x) => ({ ...x, caption }))}
            placeholder="напр. валидация заказа"
            inputStyle={fragInput}
            submitLabel="Добавить"
            onSubmit={() => void createSelfMessage(o.pid, o.caption)}
            onCancel={() => closeOverlay("self")}
          />
        );
      // Карточка шага — свой модуль: у неё есть состояние (каталог схем, поиск), а холст
      // и без того велик.
      case "msg": {
        const m = msgById.get(o.mid);
        if (!detail || !m) return null;
        return (
          <>
            <div style={overlayDim} onClick={() => closeOverlay("msg")} />
            <div style={overlayCenter}>
              <MessageCard
                processId={id}
                msg={m}
                participants={detail.participants}
                returnLegs={detail.messages.filter(
                  (x) => x.edge_id === m.edge_id && x.leg === "return",
                ).length}
                caption={o.caption}
                onCaptionChange={(caption) => updateOverlay("msg", (x) => ({ ...x, caption }))}
                onSaveCaption={() => void saveCaption(o.mid, o.caption)}
                onSetChannelSync={(edgeId, next) => void setChannelSync(edgeId, next)}
                onLinkDoc={(docId) => void linkDoc(o.mid, docId)}
                onOpenDoc={(doc) => openOverlay({ kind: "doc", ...doc })}
                catalogRev={docCatalogRev}
                onRemove={() => void removeMessage(o.mid)}
                onClose={() => closeOverlay("msg")}
              />
            </div>
          </>
        );
      }
      // Провал в схему логики (У7/У8): окно открывается просмотром, правка — его же
      // «Изменить» (Вручную | Через ИИ-агента). Колбэки настоящие, не заглушки (ловушка
      // У8): onDocEvent и onApplied перечитывают процесс (имя схемы в шаге, SET NULL при
      // удалении) и каталог карточки. Спекой этот оверлей не занимается — колбэка записи
      // спеки нет.
      case "doc":
        return (
          <DocOverlay
            mode="flowchart"
            nodeId={o.nodeId}
            nodeName={o.nodeName}
            isArchitect={isArchitect}
            initialDocId={o.docId}
            onDocEvent={() => { setDocCatalogRev((r) => r + 1); reload(); }}
            onApplied={() => { setDocCatalogRev((r) => r + 1); reload(); }}
            onClose={() => closeOverlay("doc")}
          />
        );
      // Подтверждение удаления участника (со списком связей на схеме). Идущее удаление
      // клик по подложке не бросает.
      case "delPart":
        return (
          <>
            <div style={overlayDim} onClick={() => { if (!o.busy) closeOverlay("delPart"); }} />
            <div style={overlayCenter}>
              <ParticipantDeleteConfirm
                name={o.part.name}
                links={delLinks}
                deleting={o.busy}
                error={o.error}
                onConfirm={() => void confirmRemoveParticipant(o.part)}
                onCancel={() => closeOverlay("delPart")}
              />
            </div>
          </>
        );
      // Ветвь «иначе»: условие + снятие ветви.
      case "branch":
        if (!detail) return null;
        return (
          <PromptCard
            title={o.index == null ? "Добавить ветку «иначе»" : "Ветка «иначе»"}
            hint={o.index == null
              ? "Граница встанет в свободном месте охвата — потом её можно перетащить."
              : `Ветка ${o.index + 2} у этого alt`}
            autofillKey="process-canvas-2"
            value={o.guard}
            onChange={(guard) => updateOverlay("branch", (x) => ({ ...x, guard }))}
            placeholder="условие ветки, напр. «отказ»"
            inputClassName="bp-input"
            submitLabel={o.index == null ? "Добавить" : "Сохранить"}
            onSubmit={() => void saveBranch(o)}
            onCancel={() => closeOverlay("branch")}
            extra={o.index != null && (
              <button
                className="bp-btn-ghost"
                style={{ marginRight: "auto", color: "#dc2626" }}
                onClick={() => {
                  const frag = fragById.get(o.fid);
                  closeOverlay("branch");
                  if (frag) void patchBranches(o.fid, frag.branches.filter((_, k) => k !== o.index));
                }}
              >
                Убрать ветку
              </button>
            )}
          />
        );
      // Фрагмент: ввод условия для ВЫБРАННОГО диапазона.
      case "frag":
        if (!detail) return null;
        return (
          <PromptCard
            title={`Фрагмент «${o.frag}»`}
            hint={`${o.fromRow === o.toRow
              ? `Сообщение ${o.fromRow + 1}`
              : `Сообщения ${o.fromRow + 1}–${o.toRow + 1}`} · условие (показывается у рамки)`}
            autofillKey="process-canvas-3"
            value={o.guard}
            onChange={(guard) => updateOverlay("frag", (x) => ({ ...x, guard }))}
            placeholder="напр. оплата прошла"
            inputStyle={fragInput}
            submitLabel="Добавить"
            onSubmit={() => void createFragment(o.frag, o.fromRow, o.toRow, o.guard)}
            onCancel={() => closeOverlay("frag")}
          />
        );
      // Подтверждение удаления фрагмента (клик по его шапке).
      case "delFrag":
        return (
          <>
            <div style={overlayDim} onClick={() => closeOverlay("delFrag")} />
            <div style={overlayCenter}>
              <ConfirmDialog
                variant="card"
                title="Удалить фрагмент?"
                confirmLabel="Да, удалить"
                onConfirm={() => void removeFragment(o.fid)}
                onCancel={() => closeOverlay("delFrag")}
              />
            </div>
          </>
        );
      // Расхождение имён: спрашиваем ДО записи, иначе имя из диаграммы пропало бы
      // молча. После привязки действует имя узла — схема источник истины.
      case "bindConfirm":
        return (
          <>
            <div style={overlayDim} onClick={() => closeOverlay("bindConfirm")} />
            <div style={overlayCenter}>
              <ConfirmDialog
                variant="card"
                tone="neutral"
                title="Имена расходятся"
                lead={<>
                  В диаграмме участник назывался «{o.partName}», а узел схемы —
                  «{o.nodeName}». После привязки будет действовать имя узла:
                  схема — источник истины.
                </>}
                confirmLabel="Привязать"
                onConfirm={() => void bindParticipant(o.participantId, o.nodeId)}
                onCancel={() => closeOverlay("bindConfirm")}
              />
            </div>
          </>
        );
      // Привязка непривязанного участника: тот же пикер дерева, что и у добавления —
      // выбранный узел не добавляет линию жизни, а достаётся существующей.
      case "bindPart":
        if (!detail) return null;
        return (
          <>
            <div style={overlayDim} onClick={() => closeOverlay("bindPart")} />
            <div style={overlayCenter}>
              <div style={{ ...confirmCard, width: 380, textAlign: "left" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: BPT.head }}>
                    Привязать «{partById[o.pid]?.name ?? "участника"}»
                  </div>
                  <button className="bp-iconbtn" style={{ width: 26, height: 26 }} onClick={() => closeOverlay("bindPart")}>
                    <IcoClose s={14} />
                  </button>
                </div>
                <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 10 }}>
                  Участник пришёл из импорта или потерял узел при удалении. Выберите, какому
                  объекту схемы он соответствует.
                </div>
                <ParticipantPicker
                  added={new Set(detail.participants.flatMap((p) => (p.node_id ? [p.node_id] : [])))}
                  onAdd={(ids) => { if (ids[0]) void requestBind(o.pid, ids[0]); }}
                />
              </div>
            </div>
          </>
        );
      // Управление участниками.
      case "parts":
        if (!detail) return null;
        return (
          <>
            <div style={overlayDim} onClick={() => closeOverlay("parts")} />
            <div style={overlayCenter}>
              <div style={{ ...confirmCard, width: 380, textAlign: "left" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: BPT.head }}>Участники</div>
                  <button className="bp-iconbtn" style={{ width: 26, height: 26 }} onClick={() => closeOverlay("parts")}>
                    <IcoClose s={14} />
                  </button>
                </div>
                {detail.participants.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10, maxHeight: 140, overflow: "auto" }}>
                    {[...detail.participants]
                      .sort((a, b) => a.order - b.order)
                      .map((p) => (
                        <div key={p.id} style={partRow}>
                          <span style={{ color: p.node_id ? (p.is_external ? BPT.mut : BPT.sec) : BROKEN.ink, display: "inline-flex" }}>
                            {p.shape ? <C4Glyph shape={p.shape} s={15} /> : <IcoBrokenLink s={13} />}
                          </span>
                          <span style={{ fontSize: 13, color: BPT.head, flex: 1 }}>{p.name}</span>
                          <button style={partX} title="Убрать" onClick={() => requestRemoveParticipant(p)}>
                            <IcoClose s={13} />
                          </button>
                        </div>
                      ))}
                  </div>
                )}
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: ".04em", textTransform: "uppercase", color: BPT.mut, marginBottom: 6 }}>
                  Добавить из дерева схемы
                </div>
                <ParticipantPicker
                  added={new Set(detail.participants.flatMap((p) => (p.node_id ? [p.node_id] : [])))}
                  onAdd={(ids) => void addParticipants(ids)}
                />
              </div>
            </div>
          </>
        );
    }
  }

  // Колбэки диаграммы по режиму (аудит F-39): в правке — правки, в просмотре их нет вовсе
  // (по их отсутствию диаграмма прячет ручки, «призраков» и перетаскивания), зато шаг со
  // схемой логики открывает её — тем же оверлеем, что провал из карточки шага в правке.
  // Раньше — четырнадцать тернарников `editing ? cb : undefined`, по одному на проп.
  const diagramModeProps: Partial<ComponentProps<typeof SequenceDiagram>> = editing ? {
    selectMode: fragSelect,
    onSelectRange: (from, to) => {
      // Диапазон выбран (индексы строк) — ждём ввода условия перед созданием.
      if (fragSelect) openOverlay({ kind: "frag", frag: fragSelect, fromRow: from, toRow: to, guard: "" });
      setFragSelect(null);
    },
    onFragmentClick: (fid) => openOverlay({ kind: "delFrag", fid }),
    onResizeFragment: (fid, from, to) => void resizeFragment(fid, from, to),
    onMoveBranch: (fid, index, row) => void moveBranch(fid, index, row),
    onEditBranch: (fid, index) => {
      const frag = fragById.get(fid);
      const guard = index != null ? (frag?.branches[index]?.guard ?? "") : "";
      openOverlay({ kind: "branch", fid, index, guard });
    },
    onConnect: (fromPid, toPid) => {
      // Граница слоёв: диаграмма говорит УЧАСТНИКАМИ, композитор и
      // направления — узлами C4. Перевод делаем здесь, в одном месте.
      const from = nodeOfPart(fromPid);
      const to = nodeOfPart(toPid);
      // У непривязанного участника узла нет, значит нет и каналов — открывать
      // композитор не на чем.
      if (from && to) openOverlay({ kind: "composer", from, to });
    },
    canConnect: (fromPid, toPid) => {
      const from = nodeOfPart(fromPid);
      const to = nodeOfPart(toPid);
      return !!from && !!to && directions.has(`${from}>${to}`);
    },
    onSelfConnect: (pid) => openOverlay({ kind: "self", pid, caption: "" }),
    // Карточка шага: правка подписи и удаление.
    onMessageClick: (mid) => openOverlay({ kind: "msg", mid, caption: msgById.get(mid)?.caption ?? "" }),
    onBindParticipant: (pid) => openOverlay({ kind: "bindPart", pid }),
    onDeleteParticipant: (pid) => {
      const p = partById[pid];
      if (p) requestRemoveParticipant(p);
    },
    onReorderParticipants: (ids) => void reorderParticipants(ids),
    onReorderMessages: (ids) => void reorderMessages(ids),
  } : {
    onOpenDoc: (mid) => {
      const m = msgById.get(mid);
      const doc = m ? stepDoc(m, detail?.participants ?? []) : null;
      if (doc) openOverlay({ kind: "doc", ...doc });
    },
  };

  // ── Тулбар над диаграммой ─────────────────────────────────────────
  const toolbar = (
    <ProcessToolbar
      name={detail?.name ?? "Процесс"}
      scopeName={detail?.scope_name ?? "Вся схема"}
      isArchitect={isArchitect}
      editing={editing}
      onToggleEditing={onToggleEditing}
      danglingCount={danglingCount}
      onReattach={() => void reattachChannels()}
      fragSelect={fragSelect}
      onFragSelect={(k) => setFragSelect((cur) => (cur === k ? null : k))}
      canFragment={!!detail && detail.messages.length > 0}
      onAddParticipant={() => openOverlay({ kind: "parts" })}
      history={hist}
      hasStatus={hasStatus}
      view={view}
      onViewChange={setView}
    />
  );

  return (
    <div style={canvasShell} className="bp">
      {toolbar}
      {hasStatus && <ViewHint view={view} />}
      <div className="bp-canvas" style={{ flex: 1, overflow: "auto", position: "relative" }}>
        {error && <div style={{ padding: "8px 14px 0", color: "#dc2626", fontSize: 12 }}>{error}</div>}
        {/* Итог подхвата каналов: гасится кликом — это не ошибка, а сводка. */}
        {bindNote && (
          <div
            onClick={() => setBindNote(null)}
            style={{ padding: "8px 14px 0", color: BROKEN.ink, fontSize: 12, cursor: "pointer" }}
          >
            {bindNote}
          </div>
        )}
        {!detail || !seq ? (
          <div style={{ padding: 24, color: BPT.mut, fontSize: 14 }}>Загрузка…</div>
        ) : seq.participants.length === 0 ? (
          <div style={{ padding: 24, color: BPT.mut, fontSize: 14 }}>
            {editing
              ? "Добавьте участников (узлы схемы) кнопкой «Участник», затем сообщения между ними."
              : "В процессе пока нет участников и сообщений."}
          </div>
        ) : (
          // data-tour: диаграмма процесса — вторая цель шага «Бизнес-процессы» тура демо
          <div style={{ padding: "8px 12px 18px", width: "max-content" }} data-tour="process-diagram">
            <SequenceDiagram
              participants={seq.participants}
              messages={seq.messages}
              activations={activations}
              fragments={seq.fragments}
              view={view}
              ghost={editing}
              // Переход на страницу объекта — не правка: доступен и в просмотре.
              onOpenNode={onOpenNode}
              {...diagramModeProps}
            />
          </div>
        )}

        {/* Подсказка режима выбора диапазона под фрагмент */}
        {editing && fragSelect && (
          <div style={fragHintBar}>
            <span>
              Протяните по сообщениям, чтобы выделить диапазон для фрагмента{" "}
              <b style={{ color: BPT.amber }}>«{fragSelect}»</b>
            </span>
            <button className="bp-btn-ghost" style={{ height: 26, padding: "0 10px" }} onClick={() => setFragSelect(null)}>
              Отмена
            </button>
          </div>
        )}

        {/* Окна поверх холста — в порядке открытия: открытое позже ложится сверху. */}
        {overlayStack.map((o) => <Fragment key={o.kind}>{renderOverlay(o)}</Fragment>)}
      </div>
    </div>
  );
}

const canvasShell: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};
const fragHintBar: CSSProperties = {
  position: "absolute",
  top: 10,
  left: "50%",
  transform: "translateX(-50%)",
  zIndex: 7,
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "7px 8px 7px 14px",
  background: "#fffbeb",
  border: "1px solid #fcd9a8",
  borderRadius: 10,
  boxShadow: "0 6px 20px rgba(15,23,42,.12)",
  fontSize: 12.5,
  color: "#92591a",
  whiteSpace: "nowrap",
};
// Карточка «одно поле» поверх холста: рефлексивное сообщение, ветка «иначе», условие
// фрагмента (аудит F-2: три копии одной разметки). Enter — то же, что основная кнопка;
// extra — кнопка слева от «Отмена» (у ветки — «Убрать ветку»).
function PromptCard({
  title, hint, autofillKey, value, onChange, placeholder, inputStyle, inputClassName,
  submitLabel, onSubmit, onCancel, extra,
}: {
  title: string;
  hint: string;
  autofillKey: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  inputStyle?: CSSProperties;
  inputClassName?: string;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  extra?: ReactNode;
}) {
  return (
    <>
      <div style={overlayDim} onClick={onCancel} />
      <div style={overlayCenter}>
        <div style={confirmCard}>
          <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head, marginBottom: 4 }}>{title}</div>
          <div style={{ fontSize: 11.5, color: BPT.mut, marginBottom: 10 }}>{hint}</div>
          <input
            {...noAutofill(autofillKey)}
            className={inputClassName}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            style={inputStyle}
            autoFocus
            onKeyDown={(e) => { if (e.key === "Enter") onSubmit(); }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
            {extra}
            <button className="bp-btn-ghost" onClick={onCancel}>Отмена</button>
            <button className="bp-btn-primary" onClick={onSubmit}>{submitLabel}</button>
          </div>
        </div>
      </div>
    </>
  );
}

const overlayDim: CSSProperties = { position: "fixed", inset: 0, background: "rgba(15,23,42,.06)", zIndex: 50 };
const overlayCenter: CSSProperties = {
  position: "fixed",
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
  zIndex: 51,
};
const confirmCard: CSSProperties = {
  width: 300,
  background: "#fff",
  border: "1px solid " + BPT.line,
  borderRadius: 13,
  boxShadow: "0 20px 56px rgba(15,23,42,.24)",
  padding: 16,
};
const fragInput: CSSProperties = {
  width: "100%",
  height: 34,
  padding: "0 10px",
  border: "1px solid " + BPT.line,
  borderRadius: 8,
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};
const partRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 6px",
  borderRadius: 7,
  background: "#f8fafc",
};
const partX: CSSProperties = {
  border: "none",
  background: "none",
  cursor: "pointer",
  color: "#94a3b8",
  display: "inline-flex",
  padding: 2,
};
