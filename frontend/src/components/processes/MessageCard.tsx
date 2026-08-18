// Карточка шага сценария: подпись, тип канала, привязка к схеме логики, удаление.
//
// Вынесена из ProcessCanvas отдельным модулем при появлении привязки (эпик
// «процессы → доки шага», Ф3): холст и без того 1300 строк, а карточка обзавелась
// собственным состоянием — загрузкой каталога схем и поиском по нему.
//
// Барьеры челленджа, которые чинит этот файл (docs/plan-process-docs-challenge.md):
//   У5 — каталог монолита это до 202 схем на узле, поэтому список с поиском и
//        скроллом, а не столбец кнопок в карточке шириной 300;
//   У6 — шапка карточки называет участников и плечо: без них автоподстановку
//        владельца нечем проверить глазами.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { processesApi } from "../../api/processes";
import type { DocChoice, ProcessMessage, ProcessParticipant } from "../../types";
import { BPT, BROKEN } from "./tokens";

interface Props {
  processId: string;
  msg: ProcessMessage;
  participants: ProcessParticipant[];
  // Сколько шагов-ответов висит на том же канале — предупреждение при уходе в асинхрон.
  returnLegs: number;
  caption: string;
  onCaptionChange: (v: string) => void;
  onSaveCaption: () => void;
  onSetChannelSync: (edgeId: string, next: boolean) => void;
  onLinkDoc: (docId: string | null) => void;
  // Провал в привязанную схему (У7): сам оверлей рендерит РОДИТЕЛЬ — у него стек
  // Escape, и карточка не должна закрыться вместе с оверлеем.
  onOpenDoc: (doc: { docId: string; nodeId: string; nodeName: string }) => void;
  // Ревизия каталога: родитель бампает её после правок схем в оверлее — имя или
  // состав схем могли измениться, и строка привязки не должна показывать старьё.
  catalogRev: number;
  onRemove: () => void;
  onClose: () => void;
}

export default function MessageCard({
  processId, msg, participants, returnLegs, caption, onCaptionChange,
  onSaveCaption, onSetChannelSync, onLinkDoc, onOpenDoc, catalogRev, onRemove, onClose,
}: Props) {
  // Каталог грузится ЛЕНИВО, по открытию карточки: он нужен и списку выбора, и
  // строке привязки — та показывает путь узла, которого в самом шаге нет.
  const [docs, setDocs] = useState<DocChoice[] | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    processesApi.messageDocs(processId, msg.id)
      .then((cat) => {
        if (!alive) return;
        setDocs(cat.docs);
        setOwnerId(cat.default_node_id);
      })
      .catch(() => { if (alive) setDocs([]); });
    return () => { alive = false; };
  }, [processId, msg.id, catalogRev]);

  const nameOf = useCallback(
    (pid: string) => participants.find((p) => p.id === pid)?.name ?? "?",
    [participants],
  );

  // Привязанная схема с путём узла — путь берём из каталога, пока он не приехал,
  // показываем одно имя: карточка не должна ждать сети, чтобы что-то показать.
  const linked = useMemo(
    () => (msg.doc_id ? docs?.find((d) => d.id === msg.doc_id) ?? null : null),
    [docs, msg.doc_id],
  );

  // Провал в привязанную схему — на ЧТЕНИЕ (У7). Имя узла для шапки оверлея берём
  // из каталога (последний сегмент пути: схема может жить у потомка участника);
  // пока каталог не приехал — имя участника с тем же узлом, лучшего всё равно нет.
  const openLinked = useCallback(() => {
    if (!msg.doc_id || !msg.doc_node_id) return;
    const nodeName = linked?.node_path.split(" / ").pop()
      ?? participants.find((p) => p.node_id === msg.doc_node_id)?.name
      ?? "";
    onOpenDoc({ docId: msg.doc_id, nodeId: msg.doc_node_id, nodeName });
  }, [msg.doc_id, msg.doc_node_id, linked, participants, onOpenDoc]);

  // Поиск по имени схемы, адресу операции и пути узла: у монолита в каталоге две
  // сотни строк, и листать их глазами человек не станет.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = docs ?? [];
    if (!q) return all;
    return all.filter((d) =>
      d.name.toLowerCase().includes(q)
      || (d.operation ?? "").toLowerCase().includes(q)
      || d.node_path.toLowerCase().includes(q));
  }, [docs, query]);

  return (
    <div style={card}>
      {/* У6: карточка называет ЧТО это за шаг — без участников и плеча автоподстановку
          владельца проверить нечем, а «Шаг сценария» не отличает один шаг от другого. */}
      <div style={{ fontSize: 14, fontWeight: 600, color: BPT.head }}>Шаг сценария</div>
      <div style={subhead}>
        {nameOf(msg.from_participant_id)} → {nameOf(msg.to_participant_id)}
        <span style={{ color: BPT.mut }}>
          {msg.kind === "return" ? " · ответ" : msg.kind === "self" ? " · сам себе" : ""}
        </span>
      </div>

      <input
        className="bp-input"
        style={{ marginTop: 10 }}
        value={caption}
        onChange={(e) => onCaptionChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") onSaveCaption(); }}
        placeholder="что происходит на этом шаге"
        data-card="caption"
        maxLength={256}
        autoFocus
      />

      {/* Тип КАНАЛА под шагом. Правит связь целиком, поэтому говорим об этом прямо и
          предупреждаем, если уход в асинхронный сломает ответы: у асинхронного канала
          плеча «ответ» нет (AL28). */}
      {msg.edge_id && msg.edge_synchronous != null && (
        <div style={{ marginTop: 12 }}>
          <div style={hint}>Канал в схеме — правка задевает все шаги на нём</div>
          <div style={{ display: "flex", gap: 6 }}>
            {([true, false] as const).map((v) => (
              <button
                key={String(v)}
                className={msg.edge_synchronous === v ? "bp-btn-primary" : "bp-btn-ghost"}
                onClick={() => {
                  if (msg.edge_synchronous !== v && msg.edge_id) onSetChannelSync(msg.edge_id, v);
                }}
              >
                {v ? "Синхронный" : "Асинхронный"}
              </button>
            ))}
          </div>
          {msg.edge_synchronous && returnLegs > 0 && (
            <div style={{ fontSize: 11.5, color: BROKEN.ink, marginTop: 6 }}>
              У асинхронного канала нет плеча «ответ» —
              {returnLegs === 1 ? " один шаг-ответ" : ` шагов-ответов: ${returnLegs}`} сломается.
            </div>
          )}
        </div>
      )}

      {/* Привязка к схеме логики. Термина «владелец» тут НЕТ намеренно (решение Р8):
          владелец — механика подстановки, а не понятие продукта, и вводить человеку
          новое слово ради дефолта дорого. Он проявляется лишь порядком каталога. */}
      <div style={{ marginTop: 14 }}>
        <div style={hint}>Схема логики</div>
        {!picking && (
          <div style={linkRow}>
            <span style={{ flex: 1, minWidth: 0 }}>
              {msg.doc_id ? (
                /* Имя схемы — сам провал: читать логику шага и есть цель привязки.
                   Открывается НА ЧТЕНИЕ, редактор — явной кнопкой в оверлее (У7). */
                <button
                  style={linkBtn}
                  title="Открыть схему на чтение"
                  onClick={openLinked}
                >
                  {linked ? `${linked.node_path} · ${linked.name}` : msg.doc_name}
                </button>
              ) : (
                <span style={{ color: BPT.mut }}>не привязана</span>
              )}
            </span>
            <button className="bp-btn-ghost" onClick={() => { setQuery(""); setPicking(true); }}>
              {msg.doc_id ? "Изменить" : "Выбрать"}
            </button>
            {msg.doc_id && (
              <button className="bp-btn-ghost" onClick={() => onLinkDoc(null)}>Отвязать</button>
            )}
          </div>
        )}

        {picking && (
          <div style={{ marginTop: 6 }}>
            <input
              className="bp-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="поиск по имени, операции или объекту"
              autoFocus
            />
            {/* Скролл обязателен: каталог монолита — две сотни строк, а карточка
                шириной 300 без него растянулась бы за пределы экрана (У5). */}
            <div style={list}>
              {docs === null && <div style={empty}>Загружаем…</div>}
              {docs !== null && shown.length === 0 && (
                <div style={empty}>
                  {docs.length === 0
                    ? "У участников этого шага нет схем логики. Опишите объект — и схема появится здесь."
                    : "Ничего не нашлось"}
                </div>
              )}
              {shown.map((d) => (
                <button
                  key={d.id}
                  style={{
                    ...row,
                    ...(d.id === msg.doc_id ? rowActive : null),
                  }}
                  onClick={() => { onLinkDoc(d.id); setPicking(false); }}
                >
                  <span style={rowName}>{d.name}</span>
                  {/* Заглушка разведки: привязать к неописанной операции законно, но
                      человек должен видеть, что документации там пока нет. */}
                  {!d.described && <span style={stub}>не описана</span>}
                  <span style={rowPath}>{d.node_path}</span>
                  {d.node_id === ownerId && <span style={ownerMark}>исполнитель</span>}
                </button>
              ))}
            </div>
            <button className="bp-btn-ghost" onClick={() => setPicking(false)}>Отмена</button>
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
        <button className="bp-btn-ghost" style={{ marginRight: "auto", color: "#dc2626" }} onClick={onRemove}>
          Удалить
        </button>
        <button className="bp-btn-ghost" onClick={onClose}>Отмена</button>
        <button className="bp-btn-primary" onClick={onSaveCaption}>Сохранить</button>
      </div>
    </div>
  );
}

// ── стили ────────────────────────────────────────────────────────────────────
const card: CSSProperties = {
  width: 340,
  background: "#fff",
  border: "1px solid " + BPT.line,
  borderRadius: 13,
  boxShadow: "0 20px 56px rgba(15,23,42,.24)",
  padding: 16,
};
const subhead: CSSProperties = { fontSize: 12, color: BPT.head, marginTop: 2 };
const hint: CSSProperties = { fontSize: 11.5, color: BPT.mut, marginBottom: 6 };
const linkRow: CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 };
// Имя привязанной схемы — кнопка провала: цвет акцента и курсор говорят «открывается»
const linkBtn: CSSProperties = {
  display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  maxWidth: "100%", fontWeight: 600, color: BPT.accent, fontSize: 12.5,
  background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left",
};
const list: CSSProperties = {
  marginTop: 6, maxHeight: 220, overflowY: "auto",
  border: "1px solid " + BPT.line, borderRadius: 8,
};
const row: CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, width: "100%",
  padding: "6px 8px", border: "none", borderBottom: "1px solid #f1f5f9",
  background: "none", cursor: "pointer", textAlign: "left", fontSize: 12.5,
};
const rowActive: CSSProperties = { background: "#eff6ff" };
const rowName: CSSProperties = { fontWeight: 600, color: BPT.head };
const rowPath: CSSProperties = { marginLeft: "auto", fontSize: 11, color: BPT.mut, whiteSpace: "nowrap" };
const ownerMark: CSSProperties = {
  flex: "none", fontSize: 10, fontWeight: 600, color: "#166534",
  background: "#f0fdf4", borderRadius: 5, padding: "1px 5px",
};
const stub: CSSProperties = {
  flex: "none", fontSize: 10, fontWeight: 600, color: "#64748b",
  background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 5, padding: "0 5px",
};
const empty: CSSProperties = { padding: "10px 8px", fontSize: 12, color: BPT.mut };
