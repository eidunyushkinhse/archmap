// Секция «Каналы» на странице узла-брокера: каналы и поля их сообщений.
//
// Зеркало «Структуры» у базы (DbStructureSection) по устройству, но не по смыслу:
// канал — «контракт» брокера (docs/plan-broker-docs.md §2), и у него есть своя мета
// доставки (ключ партиционирования, гарантия, retention), которой у таблицы нет.
// Хранится ЗАПИСЯМИ: обратный индекс «кто публикует / кто потребляет» — разворот
// пометок из схем логики, и собрать его из текста mermaid было бы нечем. Сам индекс
// (Ф2) СВОЕГО ввода не имеет: он производен от текста доков и правится в них.
//
// Правки идут по blur/change поштучно (как поля свойств узла), без формы и кнопки
// «Сохранить»: каналов много, а правка — точечная.
//
// Вид (редизайн, направление А «Документ») — тот же, что у «Структуры» базы: без рамок,
// между каналами волосяная линия, имя моноширинным, назначение строкой ниже; пустые
// необязательные поля и крестик видны при наведении (factRows.css). «Добавить» — в
// строке заголовка. Пустой список: у редактора только заголовок и «Добавить», у
// читателя раздела нет.
import { useRef, useState } from "react";
import { brokerChannelsApi } from "../api/nodes";
import AddDocsMenu from "./AddDocsMenu";
import ChannelsAgentModal from "./docsImport/ChannelsAgentModal";
import { useCollapse } from "./useCollapse";
import { useShrinkAnchor } from "./useShrinkAnchor";
import FactGroups from "./FactGroups";
import { freeName, useFactRows, useToggleSet } from "./useFactRows";
import { ChevronDownIcon, PlusIcon } from "../ui/icons";
import type { BrokerChannel, ChannelField, ChannelUsage } from "../types";
import "./factRows.css";
import "./brokerChannels.css";
import { LimitNotice } from "./demo/DemoLimitNotice";
import { noAutofill } from "../ui/noAutofill";
import GrowField from "../ui/GrowField";
import Section from "../ui/Section";
import "../ui/ds.css";

interface Props {
  nodeId: string;
  // Имя объекта: окно дозаливки называет его в подзаголовке — к нему уезжают каналы
  // из файла без адреса «# archmap-node:».
  nodeName: string;
  isArchitect: boolean;
}

// Подсказки терминов вынесены в константы: одни и те же слова стоят в placeholder и в
// title, и разъезжаться им нельзя. Термины перечисляют РАЗНЫЕ движки — «канал» в
// ArchMap намеренно нейтрален (как «раздел» у базы).
const GROUP_TITLE =
  "Группа каналов: vhost в RabbitMQ, namespace в Pulsar, account в NATS. " +
  "Пусто, если у брокера такого уровня нет (Kafka)";
const KIND_TITLE =
  "Вид канала: topic в Kafka, queue и exchange в RabbitMQ, stream в Redis, subject в NATS";
const DELIVERY_TITLE =
  "Гарантия доставки: at-least-once, at-most-once, exactly-once. От неё зависит, " +
  "обязана ли обработка быть идемпотентной";
const RETENTION_TITLE =
  "Сколько сообщение живёт в канале: «7d», «до ack», «compacted». Отвечает на вопрос " +
  "«что найдётся при переигрывании»";
const KEY_TITLE =
  "Ключ партиционирования: по нему определяется порядок применения событий одной сущности";

export default function BrokerChannelsSection({ nodeId, nodeName, isArchitect }: Props) {
  // Обратный индекс (usage): кто публикует и кто потребляет каналы этого брокера.
  // Разворот пометок из схем логики вызывающих — ответ на «кого сломает изменение
  // формата».
  const { rows: channels, usage, error, limit, apply, reload } =
    useFactRows(nodeId, brokerChannelsApi, "Не удалось загрузить каналы");
  const [open, toggleOpen] = useToggleSet();
  // Окно дозаливки от агента: открывается пунктом того же меню, что и «Вручную».
  const [agentOpen, setAgentOpen] = useState(false);
  // Сворачивание укорачивает страницу, и внизу скролл упирается в новый конец —
  // содержимое уезжает из-под курсора. Якорь придерживает позицию (см. хук).
  const holdScroll = useShrinkAnchor();

  const addChannel = () => {
    // Поля с серверным дефолтом генерат делает ОБЯЗАТЕЛЬНЫМИ (openapi-typescript,
    // default-non-nullable) — заполняем теми же значениями явно.
    void apply(() => brokerChannelsApi.create(nodeId, {
      name: freeName("канал", (channels ?? []).map((c) => c.name)),
      group_name: "", kind: "", partition_key: "", delivery: "", retention: "",
    }));
  };

  const addField = (channel: BrokerChannel) => {
    void apply(() => brokerChannelsApi.createField(nodeId, channel.id, {
      name: freeName("поле", channel.fields.map((f) => f.name)),
      type: "",
      required: false,
      order: channel.fields.length,
    }));
  };

  // Пока список не приехал, раздела нет: строка «Загрузка» у каждого брокера была бы шумом.
  if (channels === null && error === null) return null;
  const list = channels ?? [];
  if (error === null && list.length === 0 && !isArchitect) return null;

  const renderChannel = (c: BrokerChannel) => (
    <ChannelItem
      key={c.id}
      channel={c}
      nodeId={nodeId}
      isArchitect={isArchitect}
      usage={usage.filter((u) => u.channel_id === c.id)}
      expanded={open.has(c.id)}
      onToggle={(el) => {
        // Придерживаем скролл ДО правки: свернуть — значит укоротить страницу.
        if (open.has(c.id)) holdScroll(el);
        toggleOpen(c.id);
      }}
      apply={apply}
      onAddField={() => addField(c)}
    />
  );

  return (
    <Section
      title="Каналы"
      // Тот же вход, что у «Логики», «OpenAPI» и структуры базы: «вручную / через
      // агента» — пункты одного меню.
      actions={isArchitect && (
        <AddDocsMenu
          align="right"
          groups={[
            [{ label: "Вручную", onSelect: addChannel }],
            [{ label: "Через ИИ-агента", onSelect: () => setAgentOpen(true) }],
          ]}
        />
      )}
    >
      {error && <p className="np-warn">{error}</p>}
      {limit && <LimitNotice message={limit} />}
      {/* Каналы по группам (vhost/namespace/account — см. подпись поля). */}
      {list.length > 0 && (
        <FactGroups
          items={list}
          idOf={(c) => c.id}
          groupOf={(c) => c.group_name}
          ungrouped="без группы"
          holdScroll={holdScroll}
          render={renderChannel}
        />
      )}
      {agentOpen && (
        <ChannelsAgentModal
          nodeId={nodeId}
          nodeName={nodeName}
          onClose={() => setAgentOpen(false)}
          onApplied={reload}
        />
      )}
    </Section>
  );
}

function ChannelItem({
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

  // Раскрывашка тела едет с той же длительностью, что переезд записей, а раздел
  // вокруг растёт за ней сам: у него высота auto, и фиксировать её здесь не нужно.
  const bodyRef = useRef<HTMLDivElement>(null);
  const showBody = useCollapse(bodyRef, expanded);

  return (
    <div className="fact-item" data-flip-id={channel.id}>
      <div className="fact-head bch-head">
        <button type="button" className="fact-chev" onClick={(e) => onToggle(e.currentTarget)}
          aria-expanded={expanded}
          aria-label={expanded ? "Свернуть канал" : "Развернуть канал"}>
          <span className={"ds-chev" + (expanded ? "" : " is-closed")}><ChevronDownIcon /></span>
        </button>
        {isArchitect ? (
          <GrowField
            {...noAutofill("broker-channels-section-1")}
            className="fact-name"
            aria-label="Канал"
            initial={channel.name}
            key={`n:${channel.id}:${channel.version}`}
            onCommit={(v) => { if (v !== channel.name) patch({ name: v }); }}
          />
        ) : (
          <span className="fact-name">{channel.name}</span>
        )}
        {isArchitect ? (
          <GrowField
            {...noAutofill("broker-channels-section-2")}
            className="fact-aux"
            aria-label="Группа"
            // ГРУППА — намеренно нейтральное слово: у каждого движка свой термин для
            // этого уровня (vhost в RabbitMQ, namespace в Pulsar, account в NATS), а
            // уровня может не быть вовсе (Kafka) — тогда поле просто пустое.
            placeholder="группа"
            title={GROUP_TITLE}
            initial={channel.group_name}
            key={`g:${channel.id}:${channel.version}`}
            onCommit={(v) => { if (v !== channel.group_name) patch({ group_name: v }); }}
          />
        ) : (
          <span className="fact-aux">{channel.group_name}</span>
        )}
        {isArchitect ? (
          <GrowField
            {...noAutofill("broker-channels-section-3")}
            className="fact-aux"
            aria-label="Вид"
            placeholder="вид"
            title={KIND_TITLE}
            initial={channel.kind}
            key={`k:${channel.id}:${channel.version}`}
            onCommit={(v) => { if (v !== channel.kind) patch({ kind: v }); }}
          />
        ) : (
          <span className="fact-aux">{channel.kind}</span>
        )}
        {isArchitect && (
          <button type="button" className="ds-del" title="Удалить канал"
            aria-label={`Удалить канал ${channel.name}`}
            onClick={() => void apply(() => brokerChannelsApi.delete(nodeId, channel.id))}>×</button>
        )}
        {isArchitect ? (
          <GrowField
            {...noAutofill("broker-channels-section-7")}
            className="fact-desc"
            aria-label="Назначение канала"
            placeholder="назначение канала"
            multiline
            initial={channel.description ?? ""}
            key={`d:${channel.id}:${channel.version}`}
            onCommit={(v) => { if (v !== (channel.description ?? "")) patch({ description: v }); }}
          />
        ) : channel.description ? (
          <p className="fact-desc">{channel.description}</p>
        ) : null}
      </div>

      {showBody && (
        // Голая обёртка ведёт высоту, косметика — на .fact-body (см. GroupBody в FactGroups).
        <div ref={bodyRef} className="anim-box">
          <div className="fact-body">
          {/* Мета доставки — ради неё канал отдельная сущность, а не «таблица». Именно
              эти три поля отвечают на инциденты эпика: порядок применения событий
              (ключ), повторная обработка (гарантия), «при переигрывании ничего не
              нашлось» (retention). */}
          {isArchitect ? (
            <div className="bch-meta">
              <label className="bch-meta-cell" title={KEY_TITLE}>
                <span className="bch-meta-label">Ключ партиционирования</span>
                <GrowField {...noAutofill("broker-channels-section-4")} placeholder="—"
                  initial={channel.partition_key}
                  key={`p:${channel.id}:${channel.version}`}
                  onCommit={(v) => { if (v !== channel.partition_key) patch({ partition_key: v }); }} />
              </label>
              <label className="bch-meta-cell" title={DELIVERY_TITLE}>
                <span className="bch-meta-label">Гарантия доставки</span>
                <GrowField {...noAutofill("broker-channels-section-5")} placeholder="—"
                  initial={channel.delivery}
                  key={`dl:${channel.id}:${channel.version}`}
                  onCommit={(v) => { if (v !== channel.delivery) patch({ delivery: v }); }} />
              </label>
              <label className="bch-meta-cell" title={RETENTION_TITLE}>
                <span className="bch-meta-label">Хранение</span>
                <GrowField {...noAutofill("broker-channels-section-6")} placeholder="—"
                  initial={channel.retention}
                  key={`r:${channel.id}:${channel.version}`}
                  onCommit={(v) => { if (v !== channel.retention) patch({ retention: v }); }} />
              </label>
            </div>
          ) : (channel.partition_key || channel.delivery || channel.retention) ? (
            <div className="bch-meta-ro">
              {channel.partition_key && <span title={KEY_TITLE}>ключ: {channel.partition_key}</span>}
              {channel.delivery && <span title={DELIVERY_TITLE}>доставка: {channel.delivery}</span>}
              {channel.retention && <span title={RETENTION_TITLE}>хранение: {channel.retention}</span>}
            </div>
          ) : null}

          {/* Поля сообщения — «колонки» канала: вопрос сопровождения «откуда в событии
              X значение Y» без них не отвечается. */}
          {channel.fields.length > 0 && (
            <div className={"fact-sub" + (isArchitect ? " bch-fields" : " bch-fields--ro")}>
              {/* Шапка: без неё колонка типа неотличима от колонки смысла. Треки — те
                  же, что у строк. */}
              <div className="fact-subrow fact-subhead" aria-hidden>
                <span>Поле</span>
                <span>Тип</span>
                {isArchitect ? <span>Обязательное</span> : <span>Признаки</span>}
                <span>Смысл значения</span>
                {isArchitect && <span />}
              </div>
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
            </div>
          )}
          {isArchitect && (
            <button type="button" className="ds-add fact-addrow" onClick={onAddField}>
              <PlusIcon size={12} />Добавить поле
            </button>
          )}

          {/* Кто трогает этот канал. Пометок нет — так и говорим, и говорим
              КОНКРЕТНО: молчание значило бы «событие никому не нужно», а «обращений
              не описано» отправляло бы искать форму ввода, которой нет — публикация
              и потребление живут строкой в тексте схемы логики вызывающего. */}
          <div className="fact-usage">
            <div className="ds-sub">Кто публикует / кто потребляет</div>
            {usage.length === 0 ? (
              <p className="fact-usage-empty">
                Ни одна схема логики не говорит, кто публикует в этот канал и кто его читает
              </p>
            ) : usage.map((u) => (
              <div key={`${u.doc_id}:${u.field_id ?? ""}:${u.mode}`} className="fact-usage-row">
                <span className={"fact-mode" + (u.mode === "publish" ? " fact-mode--strong" : "")}>
                  {u.mode === "publish" ? "публикует" : "потребляет"}
                </span>
                <span className="fact-mono">
                  {u.field_name ? `${u.channel_name}.${u.field_name}` : u.channel_name}
                </span>
                <span>{u.node_name} · {u.doc_name}</span>
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
      <div className="fact-subrow">
        <span className="fact-mono">{field.name}</span>
        <span>{field.type}</span>
        {/* Признаки — ОДНОЙ ячейкой: иначе их отсутствие сдвигало бы «смысл» влево и
            колонки строк перестали бы стоять друг под другом. */}
        <span className="fact-flags">
          {field.required && <span>обяз.</span>}
        </span>
        <span>{field.description}</span>
      </div>
    );
  }
  // Поля неуправляемые, версии у поля сообщения нет: ключ — серверное значение (аудит
  // F-55), как у колонок базы.
  return (
    <div className="fact-subrow">
      <GrowField {...noAutofill("broker-channels-section-8")} className="fact-mono" aria-label="Поле"
        initial={field.name}
        key={`n:${field.id}:${field.name}`}
        onCommit={(v) => { if (v !== field.name) patch({ name: v }); }} />
      <GrowField {...noAutofill("broker-channels-section-9")} aria-label="Тип" placeholder="—"
        initial={field.type}
        key={`t:${field.id}:${field.type}`}
        onCommit={(v) => { if (v !== field.type) patch({ type: v }); }} />
      {/* Подпись называет шапка — в каждой строке она читалась бы столбиком-шумом. */}
      <input type="checkbox" className="fact-check" checked={field.required}
        title="Обязательное поле" aria-label="Обязательное поле"
        onChange={(e) => patch({ required: e.target.checked })} />
      {/* Смысл значения ОСОБЕННО важен у enum-подобных полей (event_type, status):
          перечень значений — это и есть ответ на «что означает это событие». */}
      <GrowField {...noAutofill("broker-channels-section-10")} aria-label="Смысл значения" placeholder="—"
        multiline
        initial={field.description ?? ""}
        key={`d:${field.id}:${field.description ?? ""}`}
        onCommit={(v) => { if (v !== (field.description ?? "")) patch({ description: v }); }} />
      <button type="button" className="ds-del" title="Удалить поле"
        aria-label={`Удалить поле ${field.name}`}
        onClick={() => void apply(() => brokerChannelsApi.deleteField(nodeId, channelId, field.id))}
      >×</button>
    </div>
  );
}
