// Секция «Каналы» на странице узла-брокера: каналы и поля их сообщений.
//
// Зеркало «Структуры» у базы (DbStructureSection) по устройству, но не по смыслу:
// канал — «контракт» брокера (docs/plan-broker-docs.md §2), и у него есть своя мета
// доставки (ключ партиционирования, гарантия, retention), которой у таблицы нет.
// Хранится ЗАПИСЯМИ: обратный индекс «кто публикует / кто потребляет» — разворот
// пометок из схем логики, и собрать его из текста mermaid было бы нечем. Сам индекс
// (Ф2) СВОЕГО ввода не имеет: он производен от текста доков и правится в них.
//
// Правки идут по blur/change поштучно (как инлайн-поля свойств узла), без формы и
// кнопки «Сохранить»: каналов много, а правка — точечная.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { brokerChannelsApi } from "../api/nodes";
import AddDocsMenu from "./AddDocsMenu";
import ChannelsAgentModal from "./docsImport/ChannelsAgentModal";
import { useCollapse } from "./useCollapse";
import { useFlipRows } from "./useFlipRows";
import { useShrinkAnchor } from "./useShrinkAnchor";
import { ChevronDownIcon } from "../ui/icons";
import type { BrokerChannel, ChannelField, ChannelUsage } from "../types";
import "./brokerChannels.css";
import { limitMessage } from "./demo/demoLimits";
import type { LimitMessage } from "./demo/demoLimits";
import { LimitNotice } from "./demo/DemoLimitNotice";

interface Props {
  nodeId: string;
  // Имя объекта: окно дозаливки называет его в подзаголовке — к нему уезжают каналы
  // из файла без адреса «# archmap-node:».
  nodeName: string;
  isArchitect: boolean;
}

// Свободное имя вида «канал», «канал_2», … — чтобы «+ Канал» не упиралась в 409
// уникальности при повторном нажатии.
function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// Подсказки терминов вынесены в константы: одни и те же слова стоят в placeholder и в
// title, и разъезжаться им нельзя. Термины перечисляют РАЗНЫЕ движки — «канал» в
// ArchMap намеренно нейтрален (как «раздел» у базы).
const GROUP_TITLE =
  "Группа каналов: vhost в RabbitMQ, namespace в Pulsar, account в NATS. " +
  "Пусто — у этого брокера такого уровня нет (Kafka)";
const KIND_TITLE =
  "Вид канала: topic в Kafka, queue и exchange в RabbitMQ, stream в Redis, subject в NATS";
const DELIVERY_TITLE =
  "Гарантия доставки: at-least-once, at-most-once, exactly-once — от неё зависит, " +
  "обязана ли обработка быть идемпотентной";
const RETENTION_TITLE =
  "Сколько сообщение живёт в канале: «7d», «до ack», «compacted» — отвечает на вопрос " +
  "«что найдётся при переигрывании»";
const KEY_TITLE =
  "Ключ партиционирования: по нему определяется порядок применения событий одной сущности";

export default function BrokerChannelsSection({ nodeId, nodeName, isArchitect }: Props) {
  const [channels, setChannels] = useState<BrokerChannel[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState<LimitMessage | null>(null);
  // Окно дозаливки от агента: открывается пунктом того же меню, что и «Вручную».
  const [agentOpen, setAgentOpen] = useState(false);
  // Свёрнутые группы (по умолчанию раскрыты — иначе структура выглядит пустой).
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  // Обратный индекс: кто публикует и кто потребляет каналы этого брокера. Разворот
  // пометок из схем логики вызывающих — ответ на «кого сломает изменение формата».
  const [usage, setUsage] = useState<ChannelUsage[]>([]);
  // Сворачивание укорачивает страницу, и внизу скролл упирается в новый конец —
  // содержимое уезжает из-под курсора. Якорь придерживает позицию (см. хук).
  const holdScroll = useShrinkAnchor();
  // Переезд карточки между плоским списком и группой анимируем (FLIP): без этого она
  // мгновенно оказывается в другом месте и это читается как рывок.
  const listRef = useRef<HTMLDivElement>(null);

  // Перезагрузка — через счётчик, а не вызовом загрузчика из эффекта: setState прямо
  // в теле эффекта даёт каскад рендеров (тот же приём, что в DbStructureSection).
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let alive = true;
    brokerChannelsApi.list(nodeId)
      .then((cs) => { if (alive) { setChannels(cs); setError(null); } })
      .catch(() => { if (alive) setError("Не удалось загрузить каналы"); });
    brokerChannelsApi.usage(nodeId)
      .then((u) => { if (alive) setUsage(u); })
      .catch(() => { if (alive) setUsage([]); });
    return () => { alive = false; };
  }, [nodeId, seq]);

  // Любая правка: применяем на сервере и перечитываем список. Перечитывание — не лень,
  // а необходимость: CAS-версия канала и порядок полей приходят с сервера, и локальная
  // склейка разъезжалась бы с ними на первой же ошибке.
  const apply = useCallback(async (fn: () => Promise<unknown>) => {
    setLimit(null);
    try {
      await fn();
      setError(null);
    } catch (e) {
      // Демо-стенд: правка упёрлась в предел проекта — отдельной плашкой с жирным
      // началом (docs/tasks/demo-mode.md); прочие отказы — как раньше.
      const refusal = limitMessage(e, "save");
      if (refusal) setLimit(refusal);
      else setError(e instanceof Error && e.message ? e.message : "Правка не прошла");
    }
    setSeq((n) => n + 1);
  }, [setSeq]);

  const addChannel = () => {
    const taken = new Set((channels ?? []).map((c) => c.name));
    // Поля с серверным дефолтом генерат делает ОБЯЗАТЕЛЬНЫМИ (openapi-typescript,
    // default-non-nullable) — заполняем теми же значениями явно.
    void apply(() => brokerChannelsApi.create(nodeId, {
      name: freeName("канал", taken),
      group_name: "", kind: "", partition_key: "", delivery: "", retention: "",
    }));
  };

  const addField = (channel: BrokerChannel) => {
    const taken = new Set(channel.fields.map((f) => f.name));
    void apply(() => brokerChannelsApi.createField(nodeId, channel.id, {
      name: freeName("поле", taken),
      type: "",
      required: false,
      order: channel.fields.length,
    }));
  };

  // Каналы по группам (vhost/namespace/account — см. подпись поля). Пустая группа идёт
  // первой: у Kafka такого уровня нет вовсе, и она там единственная.
  const grouped: [string, BrokerChannel[]][] = [];
  for (const c of channels ?? []) {
    const bucket = grouped.find(([k]) => k === c.group_name);
    if (bucket) bucket[1].push(c);
    else grouped.push([c.group_name, [c]]);
  }
  grouped.sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));

  // Подпись перестройки для FLIP — только про ПЕРЕЕЗД карточек: свёртка группы позиций
  // не меняет (тело едет само), и включать её сюда незачем.
  const flipKey = (channels ?? []).map((c) => `${c.id}:${c.group_name}`).join("|");
  useFlipRows(listRef, flipKey);

  const renderChannel = (c: BrokerChannel) => (
    <ChannelCard
      key={c.id}
      channel={c}
      nodeId={nodeId}
      isArchitect={isArchitect}
      usage={usage.filter((u) => u.channel_id === c.id)}
      expanded={open.has(c.id)}
      onToggle={(el) => {
        // Придерживаем скролл ДО правки: свернуть — значит укоротить страницу.
        if (open.has(c.id)) holdScroll(el);
        setOpen((prev) => {
          const next = new Set(prev);
          if (next.has(c.id)) next.delete(c.id); else next.add(c.id);
          return next;
        });
      }}
      apply={apply}
      onAddField={() => addField(c)}
    />
  );

  if (channels === null && error === null) {
    return (
      <div className="np-card">
        <h3 className="np-card-title">Каналы</h3>
        <p className="np-empty">Загрузка…</p>
      </div>
    );
  }

  return (
    <div className="np-card" data-tour="node-channels">
      <h3 className="np-card-title">Каналы</h3>
      {error && <p className="np-warn">{error}</p>}
      {limit && <LimitNotice message={limit} />}
      <div ref={listRef}>
      {(channels ?? []).length === 0 ? (
        <p className="np-empty">Каналы не описаны</p>
      ) : grouped.length > 1 ? (
        // Группы показываем ТОЛЬКО когда они реально заданы: у брокеров без такого
        // уровня (Kafka) лишняя вложенность была бы шумом — то же правило, что у
        // разделов базы.
        grouped.map(([group, list]) => (
          <div key={group} className="bch-group np-group">
            {/* Те же классы, что у групп доков на странице объекта: раскрывашка должна
                выглядеть как соседние, а не как своя выдумка. */}
            <button
              type="button"
              className="np-doc-group-toggle"
              aria-expanded={!closedGroups.has(group)}
              onClick={(e) => {
                if (!closedGroups.has(group)) holdScroll(e.currentTarget);
                setClosedGroups((prev) => {
                  const next = new Set(prev);
                  if (next.has(group)) next.delete(group); else next.add(group);
                  return next;
                });
              }}
            >
              <span className="np-doc-group-chev"
                style={{ transform: closedGroups.has(group) ? "rotate(-90deg)" : "none" }}>
                <ChevronDownIcon />
              </span>
              {group || "без группы"}
            </button>
            <GroupBody open={!closedGroups.has(group)}>{list.map(renderChannel)}</GroupBody>
          </div>
        ))
      ) : (
        <div className="bch-channels">{(channels ?? []).map(renderChannel)}</div>
      )}
      </div>
      {isArchitect && (
        <div className="bch-actions">
          {/* Тот же вход, что у «Логики», «OpenAPI» и структуры базы: одна кнопка с
              шевроном, а «вручную / через агента» — пункты меню. Два способа завести
              одну и ту же сущность не должны выглядеть как две разные кнопки. */}
          <AddDocsMenu
            label="+ Канал"
            groups={[
              [{ label: "Вручную", onSelect: addChannel }],
              [{ label: "Через ИИ-агента", onSelect: () => setAgentOpen(true) }],
            ]}
          />
        </div>
      )}
      {agentOpen && (
        <ChannelsAgentModal
          nodeId={nodeId}
          nodeName={nodeName}
          onClose={() => setAgentOpen(false)}
          onApplied={() => setSeq((n) => n + 1)}
        />
      )}
    </div>
  );
}

// Тело группы: высоту ведёт ОНО САМО, а список и карточка секции живут с auto и
// следуют за ним (разбор ловушки — в GroupBody у DbStructureSection).
function GroupBody({ open, children }: { open: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const show = useCollapse(ref, open);
  if (!show) return null;
  // Анимируем ГОЛУЮ обёртку, вся косметика — на внутреннем блоке: у блока с
  // padding/border ставить ему border-box-высоту нельзя (он content-box), а его margin
  // в height не входит вовсе — и то, и другое давало прыжок соседей.
  return (
    <div ref={ref} className="anim-box">
      <div className="bch-groupbody">{children}</div>
    </div>
  );
}

function ChannelCard({
  channel, nodeId, isArchitect, usage, expanded, onToggle, apply, onAddField,
}: {
  channel: BrokerChannel;
  nodeId: string;
  isArchitect: boolean;
  usage: ChannelUsage[];
  expanded: boolean;
  onToggle: (el: HTMLElement) => void;
  apply: (fn: () => Promise<unknown>) => Promise<void>;
  onAddField: () => void;
}) {
  const patch = (data: Parameters<typeof brokerChannelsApi.update>[2]) =>
    void apply(() => brokerChannelsApi.update(nodeId, channel.id, {
      ...data, base_version: channel.version,
    }));

  // Раскрывашка тела едет с той же длительностью, что переезд карточек, а секция
  // вокруг растёт за ней сама: у неё высота auto, и фиксировать её здесь не нужно.
  const bodyRef = useRef<HTMLDivElement>(null);
  const showBody = useCollapse(bodyRef, expanded);

  return (
    <div className="bch-channel" data-flip-id={channel.id}>
      <div className="bch-head">
        <button type="button" className="bch-chev" onClick={(e) => onToggle(e.currentTarget)}
          aria-expanded={expanded}
          aria-label={expanded ? "Свернуть канал" : "Развернуть канал"}>
          <span className="np-doc-group-chev"
            style={{ transform: expanded ? "none" : "rotate(-90deg)" }}>
            <ChevronDownIcon />
          </span>
        </button>
        {isArchitect ? (
          <input
            className="np-field bch-name"
            defaultValue={channel.name}
            key={`n:${channel.id}:${channel.version}`}
            onBlur={(e) => { if (e.target.value !== channel.name) patch({ name: e.target.value }); }}
          />
        ) : (
          <span className="bch-name bch-ro">{channel.name}</span>
        )}
        {isArchitect ? (
          <input
            className="np-field bch-group-field"
            // ГРУППА — намеренно нейтральное слово: у каждого движка свой термин для
            // этого уровня (vhost в RabbitMQ, namespace в Pulsar, account в NATS), а
            // уровня может не быть вовсе (Kafka) — тогда поле просто пустое.
            placeholder="vhost/namespace"
            title={GROUP_TITLE}
            defaultValue={channel.group_name}
            key={`g:${channel.id}:${channel.version}`}
            onBlur={(e) => {
              if (e.target.value !== channel.group_name) patch({ group_name: e.target.value });
            }}
          />
        ) : (
          <span className="bch-ro bch-group-field">{channel.group_name}</span>
        )}
        {isArchitect ? (
          <input
            className="np-field bch-kind"
            placeholder="topic/queue/exchange"
            title={KIND_TITLE}
            defaultValue={channel.kind}
            key={`k:${channel.id}:${channel.version}`}
            onBlur={(e) => { if (e.target.value !== channel.kind) patch({ kind: e.target.value }); }}
          />
        ) : (
          <span className="bch-ro bch-kind">{channel.kind}</span>
        )}
        {isArchitect && (
          <button type="button" className="bch-del" title="Удалить канал"
            onClick={() => void apply(() => brokerChannelsApi.delete(nodeId, channel.id))}>×</button>
        )}
      </div>

      {showBody && (
        // Голая обёртка ведёт высоту, косметика — на .bch-body (см. GroupBody).
        <div ref={bodyRef} className="anim-box">
          <div className="bch-body">
          {/* Мета доставки — ради неё канал отдельная сущность, а не «таблица». Именно
              эти три поля отвечают на инциденты эпика: порядок применения событий
              (ключ), повторная обработка (гарантия), «при переигрывании ничего не
              нашлось» (retention). */}
          <div className="bch-meta">
            {isArchitect ? (
              <input className="np-field" placeholder="ключ партиционирования"
                title={KEY_TITLE}
                defaultValue={channel.partition_key}
                key={`p:${channel.id}:${channel.version}`}
                onBlur={(e) => {
                  if (e.target.value !== channel.partition_key) {
                    patch({ partition_key: e.target.value });
                  }
                }} />
            ) : channel.partition_key ? (
              <span className="bch-ro" title={KEY_TITLE}>ключ: {channel.partition_key}</span>
            ) : null}
            {isArchitect ? (
              <input className="np-field" placeholder="at-least-once / at-most-once"
                title={DELIVERY_TITLE}
                defaultValue={channel.delivery}
                key={`dl:${channel.id}:${channel.version}`}
                onBlur={(e) => {
                  if (e.target.value !== channel.delivery) patch({ delivery: e.target.value });
                }} />
            ) : channel.delivery ? (
              <span className="bch-ro" title={DELIVERY_TITLE}>доставка: {channel.delivery}</span>
            ) : null}
            {isArchitect ? (
              <input className="np-field" placeholder="retention: 7d / до ack"
                title={RETENTION_TITLE}
                defaultValue={channel.retention}
                key={`r:${channel.id}:${channel.version}`}
                onBlur={(e) => {
                  if (e.target.value !== channel.retention) patch({ retention: e.target.value });
                }} />
            ) : channel.retention ? (
              <span className="bch-ro" title={RETENTION_TITLE}>хранение: {channel.retention}</span>
            ) : null}
          </div>
          {isArchitect ? (
            <input
              className="np-field bch-desc"
              placeholder="назначение канала"
              defaultValue={channel.description ?? ""}
              key={`d:${channel.id}:${channel.version}`}
              onBlur={(e) => {
                if (e.target.value !== (channel.description ?? "")) {
                  patch({ description: e.target.value });
                }
              }}
            />
          ) : channel.description ? (
            <p className="bch-desc bch-ro">{channel.description}</p>
          ) : null}

          {/* Поля сообщения — «колонки» канала: вопрос сопровождения «откуда в событии
              X значение Y» без них не отвечается. */}
          <div className="bch-fields">
            {channel.fields.length === 0 && <p className="np-empty">Поля сообщения не описаны</p>}
            {/* Шапка: без неё колонка типа неотличима от колонки смысла. Ширины — те же
                классы, что у строк, поэтому заголовки стоят ровно над своими полями. */}
            {channel.fields.length > 0 && (
              <div className={"bch-field bch-fieldhead" + (isArchitect ? "" : " bch-field--ro")}
                aria-hidden>
                <span className="bch-fname">Поле</span>
                <span className="bch-ftype">Тип</span>
                {isArchitect ? <span>обяз.</span> : <span>признаки</span>}
                <span className="bch-fdesc">Смысл значения</span>
                {isArchitect && <span />}
              </div>
            )}
            {channel.fields.map((f) => (
              <FieldRow
                key={f.id}
                field={f}
                channelId={channel.id}
                nodeId={nodeId}
                isArchitect={isArchitect}
                apply={apply}
              />
            ))}
            {isArchitect && (
              <button type="button" className="np-addbtn bch-addfield" onClick={onAddField}>
                + Поле
              </button>
            )}
          </div>

          {/* Кто трогает этот канал. Пометок нет — так и говорим, и говорим
              КОНКРЕТНО: молчание значило бы «событие никому не нужно», а «обращений
              не описано» отправляло бы искать форму ввода, которой нет — публикация
              и потребление живут строкой в тексте схемы логики вызывающего. */}
          <div className="bch-usage">
            <div className="np-sublabel">Кто публикует / кто потребляет</div>
            {usage.length === 0 ? (
              <p className="np-empty">
                Пометок «публикует:/потребляет:» на этот канал в схемах логики нет
              </p>
            ) : usage.map((u) => (
              <div key={`${u.doc_id}:${u.field_id ?? ""}:${u.mode}`} className="bch-usagerow">
                <span className={`bch-mode bch-mode--${u.mode}`}>
                  {u.mode === "publish" ? "публикует" : "потребляет"}
                </span>
                <span className="bch-ro bch-uname">
                  {u.field_name ? `${u.channel_name}.${u.field_name}` : u.channel_name}
                </span>
                <span className="bch-ro bch-udesc">{u.node_name} · {u.doc_name}</span>
              </div>
            ))}
          </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FieldRow({
  field, channelId, nodeId, isArchitect, apply,
}: {
  field: ChannelField;
  channelId: string;
  nodeId: string;
  isArchitect: boolean;
  apply: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const patch = (data: Parameters<typeof brokerChannelsApi.updateField>[3]) =>
    void apply(() => brokerChannelsApi.updateField(nodeId, channelId, field.id, data));

  if (!isArchitect) {
    return (
      <div className="bch-field bch-field--ro bch-ro">
        <span className="bch-fname">{field.name}</span>
        <span className="bch-ftype">{field.type}</span>
        {/* Признаки — ОДНОЙ ячейкой: иначе их отсутствие сдвигало бы «смысл» влево и
            колонки строк перестали бы стоять друг под другом. */}
        <span style={{ display: "flex", gap: 4, minWidth: 0 }}>
          {field.required && <span className="bch-flag">обяз.</span>}
        </span>
        <span className="bch-fdesc">{field.description}</span>
      </div>
    );
  }
  return (
    <div className="bch-field">
      <input className="np-field bch-fname" defaultValue={field.name}
        onBlur={(e) => { if (e.target.value !== field.name) patch({ name: e.target.value }); }} />
      <input className="np-field bch-ftype" placeholder="тип" defaultValue={field.type}
        onBlur={(e) => { if (e.target.value !== field.type) patch({ type: e.target.value }); }} />
      {/* Подпись «обяз.» называет шапка — в каждой строке она читалась бы столбиком-шумом. */}
      <input type="checkbox" className="bch-check" checked={field.required}
        title="Обязательное поле" aria-label="Обязательное поле"
        onChange={(e) => patch({ required: e.target.checked })} />
      {/* Смысл значения ОСОБЕННО важен у enum-подобных полей (event_type, status):
          перечень значений — это и есть ответ на «что означает это событие». */}
      <input className="np-field bch-fdesc" placeholder="смысл значения"
        defaultValue={field.description ?? ""}
        onBlur={(e) => {
          if (e.target.value !== (field.description ?? "")) patch({ description: e.target.value });
        }} />
      <button type="button" className="bch-del" title="Удалить поле"
        onClick={() => void apply(() => brokerChannelsApi.deleteField(nodeId, channelId, field.id))}
      >×</button>
    </div>
  );
}
