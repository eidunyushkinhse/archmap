// Панель шага справа от диаграммы (редизайн, фаза 3а) — вместо плавающей карточки
// «Шаг сценария» (MessageCard). Появляется при выборе шага в обоих режимах и входит в
// раскладку экрана: диаграмма сужается и вписывается заново. Это не окно поверх холста,
// поэтому в стек оверлеев она не входит; закрывают её крестик, Escape (когда сверху нет
// окна) и клик по пустому месту диаграммы — это решает холст.
//
// Чтение: номер и подпись, ниже свойства на языке страницы объекта (подпись слева тихим
// цветом, значение справа): «Откуда», «Куда», «Тип», «Технология», «Схема логики». Пустые
// свойства не показываются. Правка: те же строки, значения правятся на месте — подпись
// полем (запись по уходу с поля и по Enter, как на странице объекта), тип связи выбором,
// схема логики привязкой и отвязкой. Своих «Сохранить» и «Отмена» у панели нет; правки
// идут теми же командами истории, что и прежде (messageEdits).
//
// Что сохранено из карточки и почему (docs/plan-process-docs-challenge.md):
//   У5 — каталог схем монолита до двухсот строк: список с поиском и прокруткой;
//   У6 — участники шага названы («Откуда», «Куда»): без них подстановку исполнителя
//        нечем проверить глазами;
//   уход связи в асинхрон при живых ответах спрашивает подтверждение в момент выбора,
//   а не висит предупреждением (редизайн 2026-09-03).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { processesApi } from "../../api/processes";
import type { DocChoice, ProcessMessage, ProcessParticipant } from "../../types";
import { ChevronDownIcon } from "../../ui/icons";
import GrowField from "../../ui/GrowField";
import { noAutofill } from "../../ui/noAutofill";
import { IcoClose } from "./icons";
import { stepDoc, type StepDoc } from "./stepDoc";
import "../../ui/ds.css";
import "./processes.css";

// Тип связи под шагом — общий для всех шагов процесса на этой связи (правится связь).
const CHANNEL_HINT = "Тип задаётся у связи на схеме и общий для всех шагов процесса, которые идут по ней.";

interface Props {
  processId: string;
  msg: ProcessMessage;
  // Номер шага в сценарии (как на диаграмме).
  n: number;
  participants: ProcessParticipant[];
  editing: boolean;
  // Сколько шагов-ответов идёт по той же связи: уход в асинхрон их ломает (AL28).
  returnLegs: number;
  onSaveCaption: (caption: string) => void;
  onSetChannelSync: (edgeId: string, next: boolean) => void;
  onLinkDoc: (docId: string | null) => void;
  // Провал в привязанную схему (У7): окно рисует холст — у него стек Escape.
  onOpenDoc: (doc: StepDoc) => void;
  // Переход на страницу объекта участника (id узла).
  onOpenNode?: (nodeId: string) => void;
  // Ревизия каталога: холст поднимает её после правок схем в окне схемы.
  catalogRev: number;
  onRemove: () => void;
  onClose: () => void;
}

// Тип шага словами. Сломанный шаг называет поломку (янтарь, как чип на диаграмме).
function stepType(msg: ProcessMessage): { text: string; broken: boolean } {
  if (!msg.valid) {
    return { text: msg.invalid_reason === "leg_gone" ? "связь без ответа" : "связь удалена", broken: true };
  }
  if (msg.kind === "self") return { text: "Внутри участника", broken: false };
  if (msg.kind === "return") return { text: "Синхронный, ответ", broken: false };
  if (msg.kind === "async") return { text: "Асинхронный", broken: false };
  return { text: "Синхронный", broken: false };
}

function Prop({ term, title, children }: { term: string; title?: string; children: ReactNode }) {
  return (
    <div className="sp-prop" title={title}>
      <dt className="sp-term">{term}</dt>
      <dd className="sp-value">{children}</dd>
    </div>
  );
}

export default function StepPanel({
  processId, msg, n, participants, editing, returnLegs, onSaveCaption, onSetChannelSync,
  onLinkDoc, onOpenDoc, onOpenNode, catalogRev, onRemove, onClose,
}: Props) {
  // Каталог схем нужен только правке (выбор привязки): грузится при открытии панели
  // в правке и после правок схем в окне (catalogRev).
  const [docs, setDocs] = useState<DocChoice[] | null>(null);
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [typeOpen, setTypeOpen] = useState(false);
  // Подтверждение ухода в асинхрон помнит шаг, для которого спрошено: сменился шаг —
  // вопрос сам перестал относиться к делу (сброс производный, без эффекта).
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const askingAsync = confirmFor === msg.id;
  // Escape в поле подписи — отказ от набранного: панель закроет холст, а запись по
  // уходу с поля (если браузер пошлёт blur при снятии поля) отсекается здесь.
  const discardRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    let alive = true;
    processesApi.messageDocs(processId, msg.id)
      .then((cat) => {
        if (!alive) return;
        setDocs(cat.docs);
        setOwnerId(cat.default_node_id);
      })
      .catch(() => { if (alive) setDocs([]); });
    return () => { alive = false; };
  }, [editing, processId, msg.id, catalogRev]);

  const partOf = useCallback(
    (pid: string) => participants.find((p) => p.id === pid) ?? null,
    [participants],
  );

  // Поиск по имени схемы, адресу операции и пути узла (У5).
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = docs ?? [];
    if (!q) return all;
    return all.filter((d) =>
      d.name.toLowerCase().includes(q)
      || (d.operation ?? "").toLowerCase().includes(q)
      || d.node_path.toLowerCase().includes(q));
  }, [docs, query]);

  // Синхронный безопасен всегда; асинхронный при живых ответах — после подтверждения.
  const chooseSync = () => {
    setConfirmFor(null);
    if (msg.edge_synchronous !== true && msg.edge_id) onSetChannelSync(msg.edge_id, true);
  };
  const chooseAsync = () => {
    if (!msg.edge_id || msg.edge_synchronous === false) return;
    if (returnLegs > 0) { setConfirmFor(msg.id); return; }
    onSetChannelSync(msg.edge_id, false);
  };
  const confirmText = returnLegs === 1
    ? "По этой связи идёт шаг-ответ, а у асинхронной связи ответов не бывает. Шаг станет ошибочным."
    : `По этой связи идут шаги-ответы (${returnLegs}), а у асинхронной связи ответов не бывает. Шаги станут ошибочными.`;

  const type = stepType(msg);
  const canSwitch = editing && !!msg.edge_id && msg.edge_synchronous != null;

  // Участник ссылкой на страницу объекта; у непривязанного объекта нет — просто имя.
  const partValue = (pid: string) => {
    const p = partOf(pid);
    if (!p) return <span className="ds-empty">нет участника</span>;
    const nodeId = p.node_id;
    if (!nodeId || !onOpenNode) {
      return <span className={nodeId ? undefined : "sp-broken"} title={nodeId ? undefined : "нет объекта на схеме"}>{p.name}</span>;
    }
    return (
      <button type="button" className="sp-link" onClick={() => onOpenNode(nodeId)}>
        {p.name}
      </button>
    );
  };

  const linked = !!msg.doc_id;
  const doc = stepDoc(msg, participants);

  // Escape сначала сворачивает своё (меню типа, выбор схемы) — тогда до холста клавиша
  // не доходит, и панель остаётся. В поле подписи Escape идёт дальше и закрывает панель
  // без записи.
  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    if (typeOpen) { setTypeOpen(false); e.stopPropagation(); return; }
    if (picking) { setPicking(false); e.stopPropagation(); return; }
    if ((e.target as HTMLElement).tagName === "TEXTAREA") discardRef.current = true;
  }

  return (
    <aside className="sp-panel" aria-label="Шаг" onKeyDown={onKeyDown}>
      <div className="sp-head">
        <span className="sp-num">{n}</span>
        {editing ? (
          // Ключ по версии шага: свежая подпись с сервера приходит перемонтированием.
          <GrowField
            key={`${msg.id}:${msg.version}`}
            {...noAutofill("step-panel-1")}
            className="sp-title-field"
            aria-label="Подпись шага"
            placeholder="что происходит на этом шаге"
            maxLength={256}
            initial={msg.caption ?? ""}
            onFocus={() => { discardRef.current = false; }}
            onCommit={(v) => { if (!discardRef.current) onSaveCaption(v); }}
          />
        ) : (
          <h2 className="sp-title">{msg.caption || <span className="ds-empty">без подписи</span>}</h2>
        )}
        <button type="button" className="sp-close" title="Закрыть" aria-label="Закрыть" onClick={onClose}>
          <IcoClose s={14} />
        </button>
      </div>

      <dl className="sp-props">
        <Prop term="Откуда">{partValue(msg.from_participant_id)}</Prop>
        <Prop term="Куда">{partValue(msg.to_participant_id)}</Prop>
        <Prop term="Тип" title={msg.edge_id ? CHANNEL_HINT : undefined}>
          {canSwitch ? (
            <span className="sp-selwrap">
              <button
                type="button"
                className={"ds-value-btn" + (type.broken ? " sp-broken" : "")}
                aria-haspopup="menu"
                aria-expanded={typeOpen}
                onClick={() => setTypeOpen((o) => !o)}
              >
                {type.text}
                <span className="ds-value-chev" aria-hidden="true"><ChevronDownIcon /></span>
              </button>
              {typeOpen && (
                <>
                  <div className="sp-backdrop" onClick={() => setTypeOpen(false)} />
                  <ul className="sp-menu ds-menu" role="menu">
                    <li>
                      <button type="button" role="menuitem" className="ds-menu-item" onClick={() => { setTypeOpen(false); chooseSync(); }}>
                        Синхронный
                      </button>
                    </li>
                    <li>
                      <button type="button" role="menuitem" className="ds-menu-item" onClick={() => { setTypeOpen(false); chooseAsync(); }}>
                        Асинхронный
                      </button>
                    </li>
                  </ul>
                </>
              )}
            </span>
          ) : (
            <span className={type.broken ? "sp-broken" : undefined}>{type.text}</span>
          )}
          {askingAsync && (
            <div className="sp-confirm">
              <p>{confirmText}</p>
              <div className="sp-confirm-acts">
                <button
                  type="button"
                  className="ds-btn"
                  onClick={() => { setConfirmFor(null); if (msg.edge_id) onSetChannelSync(msg.edge_id, false); }}
                >
                  Сменить всё равно
                </button>
                <button type="button" className="ds-btn" onClick={() => setConfirmFor(null)}>
                  Оставить синхронным
                </button>
              </div>
            </div>
          )}
        </Prop>
        {msg.technology && <Prop term="Технология">{msg.technology}</Prop>}
        {(linked || editing) && (
          <Prop term="Схема логики">
            {linked ? (
              <>
                {/* Имя схемы — сам провал: открывается на чтение, как клик по значку на
                    диаграмме; правка — кнопкой окна схемы (У7). Без узла-хозяина
                    открывать нечего — имя остаётся текстом. */}
                {doc ? (
                  <button type="button" className="sp-link" onClick={() => onOpenDoc(doc)}>{msg.doc_name}</button>
                ) : (
                  <span>{msg.doc_name}</span>
                )}
                {msg.doc_node_path && (
                  <span className="sp-path" title={msg.doc_node_path}>{msg.doc_node_path}</span>
                )}
              </>
            ) : (
              <span className="ds-empty">не привязана</span>
            )}
            {editing && !picking && (
              <span className="sp-doc-acts">
                <button type="button" className="sp-quiet" onClick={() => { setQuery(""); setPicking(true); }}>
                  {linked ? "Изменить" : "Выбрать"}
                </button>
                {linked && (
                  <button type="button" className="sp-quiet" onClick={() => onLinkDoc(null)}>Отвязать</button>
                )}
              </span>
            )}
          </Prop>
        )}
      </dl>

      {editing && picking && (
        <div className="sp-picker">
          <div className="sp-picker-head">
            <input
              {...noAutofill("step-panel-2")}
              className="ds-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="поиск по имени, операции или объекту"
              autoFocus
            />
            <button type="button" className="sp-quiet" onClick={() => setPicking(false)}>свернуть</button>
          </div>
          {/* Прокрутка обязательна: каталог монолита — две сотни строк (У5). */}
          <div className="sp-list">
            {docs === null && <div className="sp-list-empty">Загружаем</div>}
            {docs !== null && shown.length === 0 && (
              <div className="sp-list-empty">
                {docs.length === 0
                  ? "У участников этого шага нет схем логики. Опишите объект, и схема появится здесь."
                  : "Ничего не нашлось"}
              </div>
            )}
            {shown.map((d) => (
              <button
                key={d.id}
                type="button"
                className={"sp-row" + (d.id === msg.doc_id ? " is-current" : "")}
                onClick={() => { onLinkDoc(d.id); setPicking(false); }}
              >
                <span className="sp-row-top">
                  <span className="sp-row-name">{d.name}</span>
                  {d.node_id === ownerId && <span className="sp-row-note">исполнитель</span>}
                  {/* Заглушка разведки: привязать к неописанной операции законно, но
                      документации там пока нет. */}
                  {!d.described && <span className="sp-row-note">не описана</span>}
                </span>
                <span className="sp-row-path" title={d.node_path}>{d.node_path}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {editing && (
        <button type="button" className="sp-delete" onClick={onRemove}>Удалить шаг</button>
      )}
    </aside>
  );
}
