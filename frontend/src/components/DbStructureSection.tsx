// Секция «Структура» на странице узла-базы: таблицы и их колонки.
//
// Структура — «контракт» базы (docs/plan-db-docs.md §1), симметрично OpenAPI у
// сервиса. Хранится ЗАПИСЯМИ: ER-диаграмма из них производна (Ф3), а обратный индекс
// «кто трогает orders.status» — разворот обращений (Ф4). Из текста mermaid ни того,
// ни другого не построить — потому редактор здесь, а не текстовое поле.
//
// Правки идут по blur/change поштучно (как инлайн-поля свойств узла), без формы и
// кнопки «Сохранить»: строк много, а правка — точечная.
import { useCallback, useEffect, useState } from "react";
import { dbTablesApi } from "../api/nodes";
import MermaidRenderer from "./MermaidRenderer";
import { tablesToErDiagram } from "./dbErDiagram";
import type { DbColumn, DbTable, TableUsage } from "../types";
import "./dbStructure.css";

interface Props {
  nodeId: string;
  isArchitect: boolean;
}

// Свободное имя вида «база», «база_2», … — чтобы «+ Таблица» не упиралась в 409
// уникальности при повторном нажатии.
function freeName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export default function DbStructureSection({ nodeId, isArchitect }: Props) {
  const [tables, setTables] = useState<DbTable[] | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // ER — производное представление тех же записей (dbErDiagram), поэтому это просто
  // переключатель показа, а не второй источник правды и не отдельное хранилище.
  const [showEr, setShowEr] = useState(false);
  // Обратный индекс: кто обращается к таблицам этой базы. Разворот тех же обращений,
  // что описаны у вызывающих, — ответ на вопрос «кто кладёт сюда значение».
  const [usage, setUsage] = useState<TableUsage[]>([]);

  // Перезагрузка — через счётчик, а не вызовом загрузчика из эффекта: setState прямо
  // в теле эффекта даёт каскад рендеров (тот же приём, что в useContainerChildren).
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let alive = true;
    dbTablesApi.list(nodeId)
      .then((ts) => { if (alive) { setTables(ts); setError(null); } })
      .catch(() => { if (alive) setError("Не удалось загрузить структуру"); });
    dbTablesApi.usage(nodeId)
      .then((u) => { if (alive) setUsage(u); })
      .catch(() => { if (alive) setUsage([]); });
    return () => { alive = false; };
  }, [nodeId, seq]);

  // Любая правка: применяем на сервере и перечитываем список. Перечитывание — не
  // лень, а необходимость: CAS-версия таблицы и порядок колонок приходят с сервера,
  // и локальная склейка разъезжалась бы с ними на первой же ошибке.
  const apply = useCallback(async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Правка не прошла");
    }
    setSeq((n) => n + 1);
  }, []);

  const addTable = () => {
    const taken = new Set((tables ?? []).map((t) => t.name));
    // Поля с серверным дефолтом генерат делает ОБЯЗАТЕЛЬНЫМИ (openapi-typescript,
    // default-non-nullable) — заполняем теми же значениями явно.
    void apply(() => dbTablesApi.create(nodeId, {
      name: freeName("таблица", taken), schema_name: "",
    }));
  };

  const addColumn = (table: DbTable) => {
    const taken = new Set(table.columns.map((c) => c.name));
    void apply(() => dbTablesApi.createColumn(nodeId, table.id, {
      name: freeName("колонка", taken),
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
      {(tables ?? []).length > 0 && (
        <div className="dbs-ertoggle">
          <button type="button" className="np-addbtn" onClick={() => setShowEr((v) => !v)}>
            {showEr ? "Скрыть диаграмму" : "Показать диаграмму"}
          </button>
        </div>
      )}
      {showEr && (
        <div className="dbs-er">
          <MermaidRenderer chart={tablesToErDiagram(tables ?? [])} />
        </div>
      )}
      {(tables ?? []).length === 0 ? (
        <p className="np-empty">Таблицы не описаны</p>
      ) : (
        <div className="dbs-tables">
          {(tables ?? []).map((t) => (
            <TableCard
              key={t.id}
              table={t}
              nodeId={nodeId}
              isArchitect={isArchitect}
              expanded={open.has(t.id)}
              onToggle={() => setOpen((prev) => {
                const next = new Set(prev);
                if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                return next;
              })}
              fkOptions={fkOptions}
              usage={usage.filter((u) => u.table_id === t.id)}
              apply={apply}
              onAddColumn={() => addColumn(t)}
            />
          ))}
        </div>
      )}
      {isArchitect && (
        <button type="button" className="np-addbtn" onClick={addTable}>+ Таблица</button>
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
  onToggle: () => void;
  fkOptions: { id: string; label: string }[];
  usage: TableUsage[];
  apply: (fn: () => Promise<unknown>) => Promise<void>;
  onAddColumn: () => void;
}) {
  const patch = (data: Parameters<typeof dbTablesApi.update>[2]) =>
    void apply(() => dbTablesApi.update(nodeId, table.id, { ...data, base_version: table.version }));

  return (
    <div className="dbs-table">
      <div className="dbs-thead">
        <button type="button" className="dbs-chev" onClick={onToggle} aria-expanded={expanded}
          aria-label={expanded ? "Свернуть колонки" : "Развернуть колонки"}>
          <span style={{ transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
        </button>
        {isArchitect ? (
          <input
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
            className="np-field dbs-schema"
            placeholder="контур"
            defaultValue={table.schema_name}
            key={`s:${table.id}:${table.version}`}
            onBlur={(e) => { if (e.target.value !== table.schema_name) patch({ schema_name: e.target.value }); }}
          />
        ) : table.schema_name ? (
          <span className="dbs-ro dbs-schema">{table.schema_name}</span>
        ) : null}
        <span className="dbs-count">{table.columns.length}</span>
        {isArchitect && (
          <button type="button" className="dbs-del" title="Удалить таблицу"
            onClick={() => void apply(() => dbTablesApi.delete(nodeId, table.id))}>×</button>
        )}
      </div>
      {isArchitect ? (
        <input
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

      {expanded && (
        <div className="dbs-cols">
          {table.columns.length === 0 && <p className="np-empty">Колонки не описаны</p>}
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
          {/* Кто трогает эту таблицу. Записей нет — так и говорим: молчание тут
              означало бы «никто не ходит», а это разные вещи. */}
          <div className="dbs-usage">
            <div className="np-sublabel">Кто обращается</div>
            {usage.length === 0 ? (
              <p className="np-empty">Обращений не описано</p>
            ) : usage.map((u) => (
              <div key={`${u.doc_id}:${u.column_id ?? ""}:${u.mode}`} className="dbs-col">
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
      <div className="dbs-col dbs-ro">
        <span className="dbs-cname">{column.name}</span>
        <span className="dbs-ctype">{column.type}</span>
        {column.is_primary_key && <span className="dbs-flag">PK</span>}
        {!column.nullable && <span className="dbs-flag">NOT NULL</span>}
        <span className="dbs-cdesc">{column.description}</span>
      </div>
    );
  }
  return (
    <div className="dbs-col">
      <input className="np-field dbs-cname" defaultValue={column.name}
        onBlur={(e) => { if (e.target.value !== column.name) patch({ name: e.target.value }); }} />
      <input className="np-field dbs-ctype" placeholder="тип" defaultValue={column.type}
        onBlur={(e) => { if (e.target.value !== column.type) patch({ type: e.target.value }); }} />
      <label className="dbs-check" title="Первичный ключ">
        <input type="checkbox" checked={column.is_primary_key}
          onChange={(e) => patch({ is_primary_key: e.target.checked })} />PK
      </label>
      <label className="dbs-check" title="Обязательное значение">
        <input type="checkbox" checked={!column.nullable}
          onChange={(e) => patch({ nullable: !e.target.checked })} />NOT NULL
      </label>
      {/* Внешний ключ КАРТЫ: из этих ссылок Ф3 рисует ER-диаграмму. */}
      <select className="np-field dbs-fk" value={column.references_column_id ?? ""}
        title="Ссылается на колонку"
        onChange={(e) => patch({ references_column_id: e.target.value || null })}>
        <option value="">без ссылки</option>
        {fkOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <input className="np-field dbs-cdesc" placeholder="смысл значения"
        defaultValue={column.description ?? ""}
        onBlur={(e) => {
          if (e.target.value !== (column.description ?? "")) patch({ description: e.target.value });
        }} />
      <button type="button" className="dbs-del" title="Удалить колонку"
        onClick={() => void apply(() => dbTablesApi.deleteColumn(nodeId, tableId, column.id))}>×</button>
    </div>
  );
}
