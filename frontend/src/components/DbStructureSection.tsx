// Раздел «Структура» на странице узла-базы: таблицы и их колонки.
//
// Структура — «контракт» базы (docs/plan-db-docs.md §1), симметрично OpenAPI у
// сервиса. Хранится ЗАПИСЯМИ: ER-диаграмма из них производна (Ф3), а обратный индекс
// «кто трогает orders.status» — разворот обращений (Ф4). Из текста mermaid ни того,
// ни другого не построить — потому редактор здесь, а не текстовое поле.
//
// Правки идут по blur/change поштучно (как поля свойств узла), без формы и кнопки
// «Сохранить»: строк много, а правка — точечная.
//
// Вид (редизайн, направление А «Документ»): без рамок, между таблицами волосяная линия,
// имя моноширинным, назначение строкой ниже; пустые необязательные поля и крестик видны
// при наведении (factRows.css). «Показать диаграмму» и «Добавить» — в строке заголовка.
// Пустая структура: у редактора только заголовок и «Добавить», у читателя раздела нет.
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
import { ChevronDownIcon, PlusIcon } from "../ui/icons";
import { tablesToErDiagram } from "./dbErDiagram";
import type { DbColumn, DbTable, TableUsage } from "../types";
import "./factRows.css";
import "./dbStructure.css";
import { LimitNotice } from "./demo/DemoLimitNotice";
import { noAutofill } from "../ui/noAutofill";
import GrowField from "../ui/GrowField";
import Section from "../ui/Section";
import "../ui/ds.css";

interface Props {
  nodeId: string;
  // Имя нужно окну дозаливки: к этому объекту уедут записи без адреса в файле.
  nodeName: string;
  isArchitect: boolean;
}

// РАЗДЕЛ — намеренно нейтральное слово: у каждого движка свой термин для этого уровня
// (schema в PostgreSQL, database в MySQL/Mongo/ClickHouse, keyspace в Cassandra), а
// «схема» в ArchMap занята диаграммой. Уровня может не быть вовсе (Redis,
// Elasticsearch) — тогда поле просто пустое.
const SCHEMA_TITLE =
  "Раздел базы: schema в PostgreSQL, database в MySQL/MongoDB/ClickHouse, keyspace в Cassandra. Пусто, если у базы такого уровня нет";

export default function DbStructureSection({ nodeId, nodeName, isArchitect }: Props) {
  // Обратный индекс (usage): кто обращается к таблицам этой базы. Разворот тех же
  // обращений, что описаны у вызывающих, — ответ на вопрос «кто кладёт сюда значение».
  const { rows: tables, usage, error, limit, apply, reload } =
    useFactRows(nodeId, dbTablesApi, "Не удалось загрузить структуру");
  const [open, toggleOpen] = useToggleSet();
  // ER — производное представление тех же записей (dbErDiagram), поэтому это просто
  // переключатель показа, а не второй источник правды и не отдельное хранилище.
  const [showEr, setShowEr] = useState(false);
  // Встроенная диаграмма ужата под ширину колонки и на реальной базе нечитаема —
  // клик по ней открывает её во весь экран с пан/зумом.
  const [erFull, setErFull] = useState(false);
  // Окно дозаливки от агента: базу с сорока таблицами руками не опишут, поэтому это
  // основной путь наполнения, а редактор ниже — для правок.
  const [agentOpen, setAgentOpen] = useState(false);
  // Сворачивание укорачивает страницу, и внизу скролл упирается в новый конец —
  // содержимое уезжает из-под курсора. Якорь придерживает позицию (см. хук).
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

  // Пока список не приехал, раздела нет: строка «Загрузка» у каждой базы была бы шумом.
  if (tables === null && error === null) return null;
  const list = tables ?? [];
  if (error === null && list.length === 0 && !isArchitect) return null;

  // Все колонки узла как цели внешнего ключа: «таблица.колонка».
  const fkOptions = list.flatMap((t) =>
    t.columns.map((c) => ({ id: c.id, label: `${t.name}.${c.name}` })),
  );

  const renderTable = (t: DbTable) => (
    <TableItem
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

  const actions = (
    <>
      {list.length > 0 && (
        <button type="button" className="ds-btn" onClick={() => setShowEr((v) => !v)}>
          {showEr ? "Скрыть диаграмму" : "Показать диаграмму"}
        </button>
      )}
      {/* Тот же вход, что у «Логики» и «OpenAPI»: «вручную / через агента» — пункты
          одного меню. Два способа завести одну сущность не должны выглядеть как две
          разные кнопки. */}
      {isArchitect && (
        <AddDocsMenu
          align="right"
          groups={[
            [{ label: "Вручную", onSelect: addTable }],
            [{ label: "Через ИИ-агента", onSelect: () => setAgentOpen(true) }],
          ]}
        />
      )}
    </>
  );

  return (
    <Section title="Структура" actions={actions}>
      {error && <p className="np-warn">{error}</p>}
      {limit && <LimitNotice message={limit} />}
      {showEr && (
        <button
          type="button"
          className="dbs-er"
          onClick={() => setErFull(true)}
          title="Открыть диаграмму во весь экран"
        >
          <MermaidRenderer chart={tablesToErDiagram(list)} />
          <span className="dbs-erhint">во весь экран</span>
        </button>
      )}
      {erFull && (
        <ErDiagramModal
          chart={tablesToErDiagram(list)}
          title={`Структура: ${nodeName}`}
          onClose={() => setErFull(false)}
        />
      )}
      {/* Таблицы по разделам (schema/database/keyspace — см. подпись поля). */}
      {list.length > 0 && (
        <FactGroups
          items={list}
          idOf={(t) => t.id}
          groupOf={(t) => t.schema_name}
          ungrouped="без раздела"
          holdScroll={holdScroll}
          render={renderTable}
        />
      )}
      {agentOpen && (
        <DataAgentModal
          nodeId={nodeId}
          nodeName={nodeName}
          onClose={() => setAgentOpen(false)}
          onApplied={reload}
        />
      )}
    </Section>
  );
}

function TableItem({
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

  // Раскрывашка колонок едет с той же длительностью, что переезд записей, а раздел
  // вокруг растёт за ней сам: у него высота auto, и фиксировать её здесь не нужно.
  const colsRef = useRef<HTMLDivElement>(null);
  const showCols = useCollapse(colsRef, expanded);

  return (
    <div className="fact-item" data-flip-id={table.id}>
      <div className="fact-head dbs-head">
        <button type="button" className="fact-chev" onClick={(e) => onToggle(e.currentTarget)}
          aria-expanded={expanded}
          aria-label={expanded ? "Свернуть колонки" : "Развернуть колонки"}>
          <span className={"ds-chev" + (expanded ? "" : " is-closed")}><ChevronDownIcon /></span>
        </button>
        {isArchitect ? (
          <GrowField
            {...noAutofill("db-structure-section-1")}
            className="fact-name"
            aria-label="Таблица"
            initial={table.name}
            key={`n:${table.id}:${table.version}`}
            onCommit={(v) => { if (v !== table.name) patch({ name: v }); }}
          />
        ) : (
          <span className="fact-name">{table.name}</span>
        )}
        {isArchitect ? (
          <GrowField
            {...noAutofill("db-structure-section-2")}
            className="fact-aux"
            aria-label="Раздел"
            placeholder="раздел"
            title={SCHEMA_TITLE}
            initial={table.schema_name}
            key={`s:${table.id}:${table.version}`}
            onCommit={(v) => { if (v !== table.schema_name) patch({ schema_name: v }); }}
          />
        ) : (
          <span className="fact-aux">{table.schema_name}</span>
        )}
        {isArchitect && (
          <button type="button" className="ds-del" title="Удалить таблицу"
            aria-label={`Удалить таблицу ${table.name}`}
            onClick={() => void apply(() => dbTablesApi.delete(nodeId, table.id))}>×</button>
        )}
        {isArchitect ? (
          <GrowField
            {...noAutofill("db-structure-section-3")}
            className="fact-desc"
            aria-label="Назначение таблицы"
            placeholder="назначение таблицы"
            multiline
            initial={table.description ?? ""}
            key={`d:${table.id}:${table.version}`}
            onCommit={(v) => { if (v !== (table.description ?? "")) patch({ description: v }); }}
          />
        ) : table.description ? (
          <p className="fact-desc">{table.description}</p>
        ) : null}
      </div>

      {showCols && (
        // Голая обёртка ведёт высоту, косметика — на .fact-body (см. GroupBody в FactGroups).
        <div ref={colsRef} className="anim-box">
          <div className="fact-body">
            {table.columns.length > 0 && (
              <div className={"fact-sub" + (isArchitect ? " dbs-cols" : " dbs-cols--ro")}>
                {/* Шапка: без неё колонка типа неотличима от колонки смысла, а два
                    чекбокса подряд не читаются вовсе. Треки — те же, что у строк. */}
                <div className="fact-subrow fact-subhead" aria-hidden>
                  <span>Колонка</span>
                  <span>Тип</span>
                  {isArchitect ? <span>Ключ</span> : <span>Признаки</span>}
                  {isArchitect && <span>Обязательная</span>}
                  {isArchitect && <span>Ссылается на</span>}
                  <span>Смысл значения</span>
                  {isArchitect && <span />}
                </div>
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
              </div>
            )}
            {isArchitect && (
              <button type="button" className="ds-add fact-addrow" onClick={onAddColumn}>
                <PlusIcon size={12} />Добавить колонку
              </button>
            )}
            {/* Кто трогает эту таблицу. Пометок нет — так и говорим, и говорим
                КОНКРЕТНО: молчание значило бы «никто не ходит», а прежнее
                «обращений не описано» отправляло искать форму ввода, которой нет —
                обращения живут строкой в тексте схемы логики. */}
            <div className="fact-usage">
              <div className="ds-sub">Кто обращается</div>
              {usage.length === 0 ? (
                <p className="fact-usage-empty">Ни одна схема логики не говорит, кто читает и пишет эту таблицу</p>
              ) : usage.map((u) => (
                <div key={`${u.doc_id}:${u.column_id ?? ""}:${u.mode}`} className="fact-usage-row">
                  <span className={"fact-mode" + (u.mode === "write" ? " fact-mode--strong" : "")}>
                    {u.mode === "write" ? "пишет" : "читает"}
                  </span>
                  <span className="fact-mono">
                    {u.column_name ? `${u.table_name}.${u.column_name}` : u.table_name}
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
      <div className="fact-subrow">
        <span className="fact-mono">{column.name}</span>
        <span>{column.type}</span>
        {/* Признаки — ОДНОЙ ячейкой: иначе их отсутствие сдвигало бы «смысл» влево
            и колонки строк перестали бы стоять друг под другом. */}
        <span className="fact-flags">
          {column.is_primary_key && <span>PK</span>}
          {!column.nullable && <span>NOT NULL</span>}
        </span>
        <span>{column.description}</span>
      </div>
    );
  }
  // Поля неуправляемые, версии у колонки нет: ключ — серверное значение (аудит F-55).
  // Сменилось на сервере (другая сессия, своя запись) — поле пересоздаётся с ним;
  // отвергнутый ввод остаётся в поле, как у таблиц.
  return (
    <div className="fact-subrow">
      <GrowField {...noAutofill("db-structure-section-4")} className="fact-mono" aria-label="Колонка"
        initial={column.name}
        key={`n:${column.id}:${column.name}`}
        onCommit={(v) => { if (v !== column.name) patch({ name: v }); }} />
      <GrowField {...noAutofill("db-structure-section-5")} aria-label="Тип" placeholder="—"
        initial={column.type}
        key={`t:${column.id}:${column.type}`}
        onCommit={(v) => { if (v !== column.type) patch({ type: v }); }} />
      {/* Подписей «PK» и «NOT NULL» в строках нет: их называет шапка, а в каждой
          строке они повторялись столбиком и читались как шум. */}
      <input type="checkbox" className="fact-check" checked={column.is_primary_key}
        title="Первичный ключ" aria-label="Первичный ключ"
        onChange={(e) => patch({ is_primary_key: e.target.checked })} />
      <input type="checkbox" className="fact-check" checked={!column.nullable}
        title="Обязательное значение" aria-label="Обязательное значение"
        onChange={(e) => patch({ nullable: !e.target.checked })} />
      {/* Внешний ключ КАРТЫ: из этих ссылок Ф3 рисует ER-диаграмму. */}
      <select className="fact-select" value={column.references_column_id ?? ""}
        title="Ссылается на колонку"
        onChange={(e) => patch({ references_column_id: e.target.value || null })}>
        <option value="">—</option>
        {fkOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <GrowField {...noAutofill("db-structure-section-6")} aria-label="Смысл значения" placeholder="—"
        multiline
        initial={column.description ?? ""}
        key={`d:${column.id}:${column.description ?? ""}`}
        onCommit={(v) => { if (v !== (column.description ?? "")) patch({ description: v }); }} />
      <button type="button" className="ds-del" title="Удалить колонку"
        aria-label={`Удалить колонку ${column.name}`}
        onClick={() => void apply(() => dbTablesApi.deleteColumn(nodeId, tableId, column.id))}>×</button>
    </div>
  );
}
