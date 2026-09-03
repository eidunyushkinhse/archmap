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
//
// Редизайн «вариант А» — решение пользователя 2026-09-03 по живому прототипу, итог
// его прохода фичи глазами. Что изменилось и почему:
//   • жаргон «канал в схеме — правка задевает все шаги на нём» убран; пояснение
//     переехало в подсказку значка ⓘ у лейбла, где его читают по желанию;
//   • предупреждение о поломке ответов больше НЕ висит постоянно (читалось как
//     упрёк ни за что) — оно стало подтверждением В МОМЕНТ клика «Асинхронный»;
//   • два больших тумблера ужаты до компактного сегмента: тип канала правят редко;
//   • имя привязанной схемы стало главным и целиком, путь узла — второй строкой:
//     прежняя строка «путь · имя» съедалась путём, и имени не оставалось;
//   • каталог выбора двухэтажный (имя с чипами / путь), а «Отмена» на экране одна —
//     нижняя карточная: каталог сворачивается текстовой ссылкой «свернуть».
import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { processesApi } from "../../api/processes";
import type { DocChoice, ProcessMessage, ProcessParticipant } from "../../types";
import { BPT } from "./tokens";

interface Props {
  processId: string;
  msg: ProcessMessage;
  participants: ProcessParticipant[];
  // Сколько шагов-ответов висит на том же канале — на них спрашиваем подтверждение
  // при уходе в асинхрон (у асинхронного канала плеча «ответ» нет, AL28).
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
  // плитке привязки — та показывает путь узла, которого в самом шаге нет.
  const [docs, setDocs] = useState<DocChoice[] | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  // Подтверждение ухода в асинхрон помнит ИМЕНЕМ шага, для которого спрошено, а не
  // голым флагом: сменился шаг — вопрос сам перестал относиться к делу. Сброс тем
  // самым производный, в рендере, без эффекта с setState.
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const askingAsync = confirmFor === msg.id;

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

  // Провал в привязанную схему — на ЧТЕНИЕ (У7). Имя узла для шапки оверлея —
  // последний сегмент пути из самого шага (схема может жить у потомка участника);
  // фолбэк на имя участника с тем же узлом, лучшего всё равно нет.
  const openLinked = useCallback(() => {
    if (!msg.doc_id || !msg.doc_node_id) return;
    const nodeName = msg.doc_node_path?.split(" / ").pop()
      ?? participants.find((p) => p.node_id === msg.doc_node_id)?.name
      ?? "";
    onOpenDoc({ docId: msg.doc_id, nodeId: msg.doc_node_id, nodeName });
  }, [msg.doc_id, msg.doc_node_id, msg.doc_node_path, participants, onOpenDoc]);

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

  // Клик по «Синхронный» безопасен всегда: ответы у синхронного канала законны.
  const chooseSync = useCallback(() => {
    setConfirmFor(null);
    if (msg.edge_synchronous !== true && msg.edge_id) onSetChannelSync(msg.edge_id, true);
  }, [msg.edge_synchronous, msg.edge_id, onSetChannelSync]);

  // А уход в асинхрон при живых плечах «ответ» ломает их — спрашиваем ровно здесь,
  // в момент выбора, а не держим предупреждение на виду постоянно.
  const chooseAsync = useCallback(() => {
    if (!msg.edge_id || msg.edge_synchronous === false) return;
    if (returnLegs > 0) { setConfirmFor(msg.id); return; }
    onSetChannelSync(msg.edge_id, false);
  }, [msg.edge_id, msg.edge_synchronous, msg.id, returnLegs, onSetChannelSync]);

  // Число согласовано с текстом: один ответ «сломается», несколько — «сломаются».
  const confirmText = returnLegs === 1
    ? "⚠ На канале 1 шаг-ответ — у асинхронного канала ответов не бывает, он сломается."
    : `⚠ На канале шагов-ответов: ${returnLegs} — у асинхронного канала ответов не бывает, они сломаются.`;

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

      {/* Тип КАНАЛА под шагом: правится связь целиком, поэтому «общий для всех шагов»
          сказано в подсказке ⓘ. Поломку ответов подтверждаем в момент выбора (AL28). */}
      {msg.edge_id && msg.edge_synchronous != null && (
        <div style={{ marginTop: 12 }}>
          <div style={label}>
            Тип канала{" "}
            <span
              style={infoI}
              title="Тип — свойство связи на C4-схеме: общий для всех шагов процесса, идущих по этой связи."
            >
              i
            </span>
          </div>
          <div style={seg}>
            <button
              type="button"
              style={{ ...segBtn, ...(msg.edge_synchronous ? segBtnOn : null) }}
              onClick={chooseSync}
            >
              Синхронный
            </button>
            <button
              type="button"
              style={{
                ...segBtn, borderLeft: "1px solid " + BPT.line,
                ...(msg.edge_synchronous ? null : segBtnOn),
              }}
              onClick={chooseAsync}
            >
              Асинхронный
            </button>
          </div>
          {askingAsync && (
            <div style={confirmBox}>
              {confirmText}
              <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
                <button
                  className="bp-btn-ghost"
                  style={amberBtn}
                  onClick={() => {
                    setConfirmFor(null);
                    if (msg.edge_id) onSetChannelSync(msg.edge_id, false);
                  }}
                >
                  Сменить всё равно
                </button>
                <button className="bp-btn-ghost" style={amberBtn} onClick={() => setConfirmFor(null)}>
                  Оставить синхронным
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Привязка к схеме логики. Термина «владелец» тут НЕТ намеренно (решение Р8):
          владелец — механика подстановки, а не понятие продукта, и вводить человеку
          новое слово ради дефолта дорого. Он проявляется лишь порядком каталога. */}
      <div style={{ marginTop: 14 }}>
        <div style={label}>Схема логики</div>
        {!picking && (
          <>
            {/* Плитка: имя схемы главное и целиком (переносится), путь — вторая строка
                с многоточием. Прежняя однострочная «путь · имя» показывала путь и
                обрывалась ровно на имени — том единственном, что человеку и нужно. */}
            <div style={docTile}>
              {msg.doc_id ? (
                <>
                  {/* Имя схемы — сам провал: читать логику шага и есть цель привязки.
                      Открывается НА ЧТЕНИЕ, редактор — явной кнопкой в оверлее (У7). */}
                  <button style={docName} title="Открыть схему на чтение" onClick={openLinked}>
                    <span style={{ minWidth: 0, wordBreak: "break-word" }}>{msg.doc_name}</span>
                    <span aria-hidden="true" style={{ fontWeight: 400, fontSize: 12 }}>↗</span>
                  </button>
                  {/* Путь узла — из самого шага (doc_node_path): карточка не ждёт сети. */}
                  {msg.doc_node_path && (
                    <div style={docPath} title={msg.doc_node_path}>{msg.doc_node_path}</div>
                  )}
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: BPT.mut }}>не привязана</div>
              )}
            </div>
            <div style={tileBtns}>
              <button className="bp-btn-ghost" style={btnSm} onClick={() => { setQuery(""); setPicking(true); }}>
                {msg.doc_id ? "Изменить" : "Выбрать"}
              </button>
              {msg.doc_id && (
                <button
                  className="bp-btn-ghost"
                  style={btnSm}
                  title="Отвязать"
                  aria-label="Отвязать"
                  onClick={() => onLinkDoc(null)}
                >
                  ×
                </button>
              )}
            </div>
          </>
        )}

        {picking && (
          <div style={{ marginTop: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                className="bp-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="поиск по имени, операции или объекту"
                autoFocus
              />
              {/* Свернуть каталог — текстовой ссылкой: словесная «Отмена» под списком
                  спорила с нижней карточной, и на экране их было две. */}
              <button style={catClose} onClick={() => setPicking(false)}>свернуть</button>
            </div>
            {/* Скролл обязателен: каталог монолита — две сотни строк, а карточка
                шириной 340 без него растянулась бы за пределы экрана (У5). */}
            <div style={list}>
              {docs === null && <div style={empty}>Загружаем…</div>}
              {docs !== null && shown.length === 0 && (
                <div style={empty}>
                  {docs.length === 0
                    ? "У участников этого шага нет схем логики. Опишите объект — и схема появится здесь."
                    : "Ничего не нашлось"}
                </div>
              )}
              {shown.map((d, i) => (
                <button
                  key={d.id}
                  style={{
                    ...row,
                    ...(i === shown.length - 1 ? { borderBottom: "none" } : null),
                    ...(d.id === msg.doc_id ? rowActive : null),
                  }}
                  onClick={() => { onLinkDoc(d.id); setPicking(false); }}
                >
                  {/* Первый этаж — имя и чипы при нём, второй — путь. Раньше имя и путь
                      делили одну строку, и длинное имя выдавливало путь в никуда. */}
                  <span style={rowTop}>
                    <span style={rowName}>{d.name}</span>
                    {d.node_id === ownerId && <span style={ownerMark}>исполнитель</span>}
                    {/* Заглушка разведки: привязать к неописанной операции законно, но
                        человек должен видеть, что документации там пока нет. */}
                    {!d.described && <span style={stub}>не описана</span>}
                  </span>
                  <span style={rowPath} title={d.node_path}>{d.node_path}</span>
                </button>
              ))}
            </div>
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
const label: CSSProperties = { fontSize: 11.5, color: BPT.mut, marginBottom: 6 };
// Значок пояснения: подсказка по наведению, а не строка-жаргон на виду
const infoI: CSSProperties = {
  display: "inline-flex", justifyContent: "center", width: 15, height: 15,
  borderRadius: "50%", border: "1px solid " + BPT.mut, color: BPT.mut,
  fontSize: 10, fontWeight: 600, lineHeight: "13px", cursor: "help", verticalAlign: -2,
};
// Сегмент типа канала: единая рамка, активная секция залита акцентом
const seg: CSSProperties = {
  display: "inline-flex", border: "1px solid " + BPT.line, borderRadius: 8, overflow: "hidden",
};
const segBtn: CSSProperties = {
  height: 26, padding: "0 11px", border: "none", background: "#fff", color: BPT.sec,
  fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
};
const segBtnOn: CSSProperties = { background: BPT.accent, color: "#fff" };
// Подтверждение смены на асинхрон — янтарь валидатора, без новых цветов
const confirmBox: CSSProperties = {
  marginTop: 8, padding: "8px 10px", border: "1px solid " + BPT.amberLine,
  background: BPT.amberBg, borderRadius: 9, fontSize: 11.5, color: BPT.amber,
};
const btnSm: CSSProperties = { height: 26, padding: "0 10px", fontSize: 12, borderRadius: 7 };
const amberBtn: CSSProperties = { ...btnSm, borderColor: BPT.amberLine, color: BPT.amber };
// Плитка привязки: имя первой строкой, путь второй
const docTile: CSSProperties = {
  border: "1px solid " + BPT.line, borderRadius: 10, padding: "9px 10px", background: "#fff",
};
const docName: CSSProperties = {
  display: "flex", alignItems: "baseline", gap: 6, maxWidth: "100%",
  fontSize: 13, fontWeight: 650, color: BPT.accent, fontFamily: "inherit",
  background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left",
};
const docPath: CSSProperties = {
  marginTop: 2, fontSize: 11, color: BPT.mut,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};
const tileBtns: CSSProperties = { display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 8 };
const catClose: CSSProperties = {
  flex: "none", padding: 2, border: "none", background: "none",
  fontSize: 11.5, fontFamily: "inherit", color: BPT.micro, cursor: "pointer",
};
const list: CSSProperties = {
  marginTop: 6, maxHeight: 236, overflowY: "auto",
  border: "1px solid " + BPT.line, borderRadius: 10, background: "#fff",
};
const row: CSSProperties = {
  display: "block", width: "100%", padding: "7px 10px 8px",
  border: "none", borderBottom: "1px solid " + BPT.line2,
  background: "none", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
};
const rowActive: CSSProperties = { background: BPT.wash };
const rowTop: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const rowName: CSSProperties = { fontSize: 12.5, fontWeight: 600, color: BPT.head };
const rowPath: CSSProperties = {
  display: "block", marginTop: 1, fontSize: 11, color: BPT.mut,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};
const ownerMark: CSSProperties = {
  flex: "none", fontSize: 10, fontWeight: 600, color: "#166534",
  background: "#f0fdf4", borderRadius: 5, padding: "1px 5px",
};
const stub: CSSProperties = {
  flex: "none", fontSize: 10, fontWeight: 600, color: BPT.micro,
  background: BPT.canvas, border: "1px dashed #cbd5e1", borderRadius: 5, padding: "0 5px",
};
const empty: CSSProperties = { padding: "10px 8px", fontSize: 12, color: BPT.mut };
