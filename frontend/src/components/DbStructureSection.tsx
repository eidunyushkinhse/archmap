// Секция «Структура» на странице узла-базы: таблицы и их колонки.
//
// Структура — «контракт» базы (docs/plan-db-docs.md §1), симметрично OpenAPI у
// сервиса. Хранится ЗАПИСЯМИ: ER-диаграмма из них производна (Ф3), а обратный индекс
// «кто трогает orders.status» — разворот обращений (Ф4). Из текста mermaid ни того,
// ни другого не построить — потому редактор здесь, а не текстовое поле.
//
// Правки идут по blur/change поштучно (как инлайн-поля свойств узла), без формы и
// кнопки «Сохранить»: строк много, а правка — точечная.
import { useRef, useState } from "react";
import { dbTablesApi } from "../api/nodes";
import AddDocsMenu from "./AddDocsMenu";
import DataAgentModal from "./docsImport/DataAgentModal";
import ErDiagramModal from "./ErDiagramModal";
import { useCollapse } from "./useCollapse";
import { useShrinkAnchor } from "./useShrinkAnchor";
import FactGroups from "./FactGroups";
import { freeName, useFactRows, useToggleSet } from "./useFactRows";
import MermaidRenderer from "./MermaidRenderer";
import { ChevronDownIcon } from "../ui/icons";
import { tablesToErDiagram } from "./dbErDiagram";
import type { DbColumn, DbTable, TableUsage } from "../types";
import "./dbStructure.css";
import { LimitNotice } from "./demo/DemoLimitNotice";
import { noAutofill } from "../ui/noAutofill";

interface Props {
  nodeId: string;
  // Имя нужно окну дозаливки: к этому объекту уедут записи без адреса в файле.
  nodeName: string;
  isArchitect: boolean;
}

export default function DbStructureSection({ nodeId, nodeName, isArchitect }: Props) {
  // Обратный индекс (usage): кто обращается к таблицам этой базы. Разворот тех же
  // обращений, что описаны у вызывающих, — ответ на вопрос «кто кладёт сюда значение».
  const { rows: tables, usage, error, limit, apply, reload } =
    useFactRows(nodeId, dbTablesApi, "Не удалось загрузить структуру");
  const [open, toggleOpen] = useToggleSet();
  // ER — производное представление тех же записей (dbErDiagram), поэтому это просто
  // переключатель показа, а не второй источник правды и не отдельное хранилище.
  const [showEr, setShowEr] = useState(false);
  // Встроенная диаграмма ужата под ширину карточки и на реальной базе нечитаема —
  // клик по ней открывает её во весь экран с пан/зумом.
  const [erFull, setErFull] = useState(false);
  // Окно дозаливки от агента: базу с сорока таблицами руками не опишут, поэтому это
  // основной путь наполнения, а редактор ниже — для правок.
  const [agentOpen, setAgentOpen] = useState(false);
  // Сворачивание укорачивает страницу, и внизу скролл упирается в новый конец —
  // содержимое уезжает из-под курсора. Якорь придерживает позицию (см. хук).
  // Контейнер прокрутки ищется от самой кнопки: реф для этого не нужен, а читать
  // рефы в обработчиках, созданных в рендере, линтер и не даёт.
  const holdScroll = useShrinkAnchor();

  const addTable = () => {
    // Поля с серверным дефолтом генерат делает ОБЯЗАТЕЛЬНЫМИ (openapi-typescript,
    // default-non-nullable) — заполняем теми же значениями явно.
    void apply(() => dbTablesApi.create(nodeId, {
      name: freeName("таблица", (tables ?? []).map((t) => t.name)), schema_name: "",
    }));
  };

  const addColumn = (table: DbTable) => {
    void apply(() => dbTablesApi.createColumn(nodeId, table.id, {
      name: freeName("колонка", table.columns.map((c) => c.name)),
      type: "",
      nullable: true,
      is_primary_key: false,
      order: table.columns.length,
    }));
  };

  // Все колонки узла как цели внешнего ключа: «таблица.колонка».
  const fkOptions = (tables ?? []).flatMap((t) =>
    t.columns.map((c) => ({ id: c.id, label: `${t.name}.${c.name}` })),
  );

  const renderTable = (t: DbTable) => (
    <TableCard
      key={t.id}
      table={t}
      nodeId={nodeId}
      isArchitect={isArchitect}
      expanded={open.has(t.id)}
      onToggle={(el) => {
        // Придерживаем скролл ДО правки: свернуть — значит укоротить страницу.
        if (open.has(t.id)) holdScroll(el);
        toggleOpen(t.id);
      }}
      fkOptions={fkOptions}
      usage={usage.filter((u) => u.table_id === t.id)}
      apply={apply}
      onAddColumn={() => addColumn(t)}
    />
  );

  if (tables === null && error === null) {
    return (
      <div className="np-card">
        <h3 className="np-card-title">Структура</h3>
        <p className="np-empty">Загрузка…</p>
      </div>
    );
  }

  return (
    <div className="np-card">
      <h3 className="np-card-title">Структура</h3>
      {error && <p className="np-warn">{error}</p>}
      {limit && <LimitNotice message={limit} />}
      {(tables ?? []).length > 0 && (
        <div className="dbs-ertoggle">
          <button type="button" className="np-addbtn" onClick={() => setShowEr((v) => !v)}>
            {showEr ? "Скрыть диаграмму" : "Показать диаграмму"}
          </button>
        </div>
      )}
      {showEr && (
        <button
          type="button"
          className="dbs-er"
          onClick={() => setErFull(true)}
          title="Открыть диаграмму во весь экран"
        >
          <MermaidRenderer chart={tablesToErDiagram(tables ?? [])} />
          <span className="dbs-erhint">во весь экран</span>
        </button>
      )}
      {erFull && (
        <ErDiagramModal
          chart={tablesToErDiagram(tables ?? [])}
          title={`Структура: ${nodeName}`}
          onClose={() => setErFull(false)}
        />
      )}
      {/* Таблицы по разделам (schema/database/keyspace — см. подпись поля). */}
      <FactGroups
        items={tables ?? []}
        idOf={(t) => t.id}
        groupOf={(t) => t.schema_name}
        ungrouped="без раздела"
        groupClass="dbs-group"
        bodyClass="dbs-groupbody"
        flatClass="dbs-tables"
        empty={<p className="np-empty">Таблицы не описаны</p>}
        holdScroll={holdScroll}
        render={renderTable}
      />
      {isArchitect && (
        <div className="dbs-actions">
          {/* Тот же вход, что у «Логики» и «OpenAPI»: одна кнопка с шевроном, а
              «вручную / через агента» — пункты меню. Два способа завести одну и ту же
              сущность не должны выглядеть как две разные кнопки. */}
          <AddDocsMenu
            label="+ Таблица"
            groups={[
              [{ label: "Вручную", onSelect: addTable }],
              [{ label: "Через ИИ-агента", onSelect: () => setAgentOpen(true) }],
            ]}
          />
        </div>
      )}
      {agentOpen && (
        <DataAgentModal
          nodeId={nodeId}
          nodeName={nodeName}
          onClose={() => setAgentOpen(false)}
          onApplied={reload}
        />
      )}
    </div>
  );
}

function TableCard({
  table, nodeId, isArchitect, expanded, onToggle, fkOptions, usage, apply, onAddColumn,
}: {
  table: DbTable;
  nodeId: string;
  isArchitect: boolean;
  expanded: boolean;
  onToggle: (el: HTMLElement) => void;
  fkOptions: { id: string; label: string }[];
  usage: TableUsage[];
  apply: (fn: () => Promise<unknown>) => Promise<void>;
  onAddColumn: () => void;
}) {
  const patch = (data: Parameters<typeof dbTablesApi.update>[2]) =>
    void apply(() => dbTablesApi.update(nodeId, table.id, { ...data, base_version: table.version }));

  // Раскрывашка колонок едет с той же длительностью, что переезд карточек, а секция
  // вокруг растёт за ней сама: у неё высота auto, и фиксировать её здесь не нужно.
  const colsRef = useRef<HTMLDivElement>(null);
  const showCols = useCollapse(colsRef, expanded);

  return (
    <div className="dbs-table" data-flip-id={table.id}>
      <div className="dbs-thead">
        <button type="button" className="dbs-chev" onClick={(e) => onToggle(e.currentTarget)}
          aria-expanded={expanded}
          aria-label={expanded ? "Свернуть колонки" : "Развернуть колонки"}>
          <span className="np-doc-group-chev"
            style={{ transform: expanded ? "none" : "rotate(-90deg)" }}>
            <ChevronDownIcon />
          </span>
        </button>
        {isArchitect ? (
          <input
            {...noAutofill("db-structure-section-1")}
            className="np-field dbs-name"
            defaultValue={table.name}
            key={`n:${table.id}:${table.version}`}
            onBlur={(e) => { if (e.target.value !== table.name) patch({ name: e.target.value }); }}
          />
        ) : (
          <span className="dbs-name dbs-ro">{table.name}</span>
        )}
        {isArchitect ? (
          <input
            {...noAutofill("db-structure-section-2")}
            className="np-field dbs-schema"
            // РАЗДЕЛ — намеренно нейтральное слово: у каждого движка свой термин для
            // этого уровня (schema в PostgreSQL, database в MySQL/Mongo/ClickHouse,
            // keyspace в Cassandra), а «схема» в ArchMap занята диаграммой. Уровня
            // может не быть вовсе (Redis, Elasticsearch) — тогда поле просто пустое.
            placeholder="схема/раздел"
            title="Раздел базы: schema в PostgreSQL, database в MySQL/MongoDB/ClickHouse, keyspace в Cassandra. Пусто — у этой базы такого уровня нет"
            defaultValue={table.schema_name}
            key={`s:${table.id}:${table.version}`}
            onBlur={(e) => { if (e.target.value !== table.schema_name) patch({ schema_name: e.target.value }); }}
          />
        ) : (
          <span className="dbs-ro dbs-schema">{table.schema_name}</span>
        )}
        {isArchitect && (
          <button type="button" className="dbs-del" title="Удалить таблицу"
            onClick={() => void apply(() => dbTablesApi.delete(nodeId, table.id))}>×</button>
        )}
      </div>
      {isArchitect ? (
        <input
          {...noAutofill("db-structure-section-3")}
          className="np-field dbs-desc"
          placeholder="назначение таблицы"
          defaultValue={table.description ?? ""}
          key={`d:${table.id}:${table.version}`}
          onBlur={(e) => {
            if (e.target.value !== (table.description ?? "")) patch({ description: e.target.value });
          }}
        />
      ) : table.description ? (
        <p className="dbs-desc dbs-ro">{table.description}</p>
      ) : null}

      {showCols && (
        // Голая обёртка ведёт высоту, косметика — на .dbs-cols (см. GroupBody в FactGroups).
        <div ref={colsRef} className="anim-box">
          <div className="dbs-cols">
          {table.columns.length === 0 && <p className="np-empty">Колонки не описаны</p>}
          {/* Шапка: без неё колонка типа неотличима от колонки смысла, а два чекбокса
              подряд не читаются вовсе. Ширины — те же классы, что у строк, поэтому
              заголовки стоят ровно над своими полями. */}
          {table.columns.length > 0 && (
            <div className={"dbs-col dbs-colhead" + (isArchitect ? "" : " dbs-col--ro")} aria-hidden>
              <span className="dbs-cname">Колонка</span>
              <span className="dbs-ctype">Тип</span>
              {isArchitect ? <span>ключ</span> : <span>признаки</span>}
              {isArchitect && <span>обяз.</span>}
              {isArchitect && <span className="dbs-fk">Ссылается на</span>}
              <span className="dbs-cdesc">Смысл значения</span>
              {isArchitect && <span />}
            </div>
          )}
          {table.columns.map((c) => (
            <ColumnRow
              key={c.id}
              column={c}
              tableId={table.id}
              nodeId={nodeId}
              isArchitect={isArchitect}
              fkOptions={fkOptions.filter((o) => o.id !== c.id)}
              apply={apply}
            />
          ))}
          {isArchitect && (
            <button type="button" className="np-addbtn dbs-addcol" onClick={onAddColumn}>
              + Колонка
            </button>
          )}
          {/* Кто трогает эту таблицу. Пометок нет — так и говорим, и говорим
              КОНКРЕТНО: молчание значило бы «никто не ходит», а прежнее
              «обращений не описано» отправляло искать форму ввода, которой нет —
              обращения живут строкой в тексте схемы логики. */}
          <div className="dbs-usage">
            <div className="np-sublabel">Кто обращается</div>
            {usage.length === 0 ? (
              <p className="np-empty">Пометок «читает:/пишет:» на эту таблицу в схемах логики нет</p>
            ) : usage.map((u) => (
              <div key={`${u.doc_id}:${u.column_id ?? ""}:${u.mode}`} className="dbs-col dbs-col--usage">
                <span className={`dbs-mode dbs-mode--${u.mode}`}>
                  {u.mode === "write" ? "пишет" : "читает"}
                </span>
                <span className="dbs-cname dbs-ro">
                  {u.column_name ? `${u.table_name}.${u.column_name}` : u.table_name}
                </span>
                <span className="dbs-cdesc dbs-ro">{u.node_name} · {u.doc_name}</span>
              </div>
            ))}
          </div>
        </div>
        </div>
      )}
    </div>
  );
}

function ColumnRow({
  column, tableId, nodeId, isArchitect, fkOptions, apply,
}: {
  column: DbColumn;
  tableId: string;
  nodeId: string;
  isArchitect: boolean;
  fkOptions: { id: string; label: string }[];
  apply: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const patch = (data: Parameters<typeof dbTablesApi.updateColumn>[3]) =>
    void apply(() => dbTablesApi.updateColumn(nodeId, tableId, column.id, data));

  if (!isArchitect) {
    return (
      <div className="dbs-col dbs-col--ro dbs-ro">
        <span className="dbs-cname">{column.name}</span>
        <span className="dbs-ctype">{column.type}</span>
        {/* Признаки — ОДНОЙ ячейкой: иначе их отсутствие сдвигало бы «смысл» влево
            и колонки строк перестали бы стоять друг под другом. */}
        <span style={{ display: "flex", gap: 4, minWidth: 0 }}>
          {column.is_primary_key && <span className="dbs-flag">PK</span>}
          {!column.nullable && <span className="dbs-flag">NOT NULL</span>}
        </span>
        <span className="dbs-cdesc">{column.description}</span>
      </div>
    );
  }
  // Поля неуправляемые, версии у колонки нет: ключ — серверное значение (аудит F-55).
  // Сменилось на сервере (другая сессия, своя запись) — поле пересоздаётся с ним;
  // отвергнутый ввод остаётся в поле, как у таблиц.
  return (
    <div className="dbs-col">
      <input {...noAutofill("db-structure-section-4")} className="np-field dbs-cname" defaultValue={column.name}
        key={`n:${column.id}:${column.name}`}
        onBlur={(e) => { if (e.target.value !== column.name) patch({ name: e.target.value }); }} />
      <input {...noAutofill("db-structure-section-5")} className="np-field dbs-ctype" placeholder="тип" defaultValue={column.type}
        key={`t:${column.id}:${column.type}`}
        onBlur={(e) => { if (e.target.value !== column.type) patch({ type: e.target.value }); }} />
      {/* Подписей «PK» и «NOT NULL» в строках больше нет: их называет шапка, а в
          каждой строке они повторялись столбиком и читались как шум. */}
      <input type="checkbox" className="dbs-check" checked={column.is_primary_key}
        title="Первичный ключ" aria-label="Первичный ключ"
        onChange={(e) => patch({ is_primary_key: e.target.checked })} />
      <input type="checkbox" className="dbs-check" checked={!column.nullable}
        title="Обязательное значение" aria-label="Обязательное значение"
        onChange={(e) => patch({ nullable: !e.target.checked })} />
      {/* Внешний ключ КАРТЫ: из этих ссылок Ф3 рисует ER-диаграмму. */}
      <select className="np-field dbs-fk" value={column.references_column_id ?? ""}
        title="Ссылается на колонку"
        onChange={(e) => patch({ references_column_id: e.target.value || null })}>
        <option value="">без ссылки</option>
        {fkOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <input {...noAutofill("db-structure-section-6")} className="np-field dbs-cdesc" placeholder="смысл значения"
        defaultValue={column.description ?? ""}
        key={`d:${column.id}:${column.description ?? ""}`}
        onBlur={(e) => {
          if (e.target.value !== (column.description ?? "")) patch({ description: e.target.value });
        }} />
      <button type="button" className="dbs-del" title="Удалить колонку"
        onClick={() => void apply(() => dbTablesApi.deleteColumn(nodeId, tableId, column.id))}>×</button>
    </div>
  );
}
