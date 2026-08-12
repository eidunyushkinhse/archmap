// Секция «Обращения к данным» на странице СЕРВИСА: что каждая его операция читает и
// пишет.
//
// РАДИ ЭТОЙ СЕКЦИИ ВЕСЬ ЭПИК (docs/plan-db-docs.md). Перечень таблиц отвечает, ГДЕ
// значение может лежать; обращения — КТО его туда кладёт, а инженеру сопровождения
// нужно именно второе: «откуда взялось это поле в этом процессе».
//
// Обращения живут у ВЫЗЫВАЮЩЕГО (у дока его операции), а не у базы — тот же принцип,
// по которому OpenAPI принадлежит поставщику API, а не тому, кто его зовёт. Обратный
// индекс на странице базы («кто ко мне ходит») — разворот этих же записей, отдельного
// ввода не требует.
import { useEffect, useState } from "react";
import { dataAccessApi, dbTablesApi } from "../api/nodes";
import type { DataAccess, NodeDocMeta, ProjectTableRef } from "../types";
import "./dbStructure.css";

interface Props {
  nodeId: string;
  docs: NodeDocMeta[];
  isArchitect: boolean;
}

const MODE_LABEL: Record<string, string> = { read: "читает", write: "пишет" };

export default function DataAccessSection({ nodeId, docs, isArchitect }: Props) {
  // Обращения всех доков узла разом: по одному запросу на док (их единицы, не сотни).
  const [byDoc, setByDoc] = useState<Record<string, DataAccess[]>>({});
  const [tables, setTables] = useState<ProjectTableRef[]>([]);
  const [seq, setSeq] = useState(0);
  const docIds = docs.map((d) => d.id).join(",");

  useEffect(() => {
    let alive = true;
    Promise.all([
      Promise.all(docs.map((d) => dataAccessApi.list(nodeId, d.id).then((a) => [d.id, a] as const))),
      dbTablesApi.catalog(),
    ])
      .then(([pairs, catalog]) => {
        if (!alive) return;
        setByDoc(Object.fromEntries(pairs));
        setTables(catalog);
      })
      .catch(() => { if (alive) setTables([]); });
    return () => { alive = false; };
    // docIds — стабильный ключ набора доков: сам массив приходит новым каждый рендер.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, docIds, seq]);

  const reload = () => setSeq((n) => n + 1);
  const total = Object.values(byDoc).reduce((n, list) => n + list.length, 0);

  if (docs.length === 0) return null;
  if (!isArchitect && total === 0) return null;

  return (
    <div className="np-card">
      <h3 className="np-card-title">Обращения к данным</h3>
      {tables.length === 0 && (
        <p className="np-empty">
          В проекте не описано ни одной таблицы — сначала опишите структуру базы
        </p>
      )}
      <div className="dbs-tables">
        {docs.map((d) => (
          <DocAccess
            key={d.id}
            nodeId={nodeId}
            doc={d}
            access={byDoc[d.id] ?? []}
            tables={tables}
            isArchitect={isArchitect}
            onChanged={reload}
          />
        ))}
      </div>
    </div>
  );
}

function DocAccess({
  nodeId, doc, access, tables, isArchitect, onChanged,
}: {
  nodeId: string;
  doc: NodeDocMeta;
  access: DataAccess[];
  tables: ProjectTableRef[];
  isArchitect: boolean;
  onChanged: () => void;
}) {
  const [tableId, setTableId] = useState("");
  const [columnId, setColumnId] = useState("");
  const [mode, setMode] = useState<"read" | "write">("read");

  const byId = new Map(tables.map((t) => [t.id, t]));
  const columns = byId.get(tableId)?.columns ?? [];

  const label = (a: DataAccess): string => {
    const t = byId.get(a.table_id);
    if (!t) return "таблица удалена";
    const col = t.columns.find((c) => c.id === a.column_id);
    // Колонка необязательна: обращение к таблице целиком — законный случай.
    return `${t.node_name} · ${t.name}${col ? `.${col.name}` : ""}`;
  };

  const add = () => {
    if (!tableId) return;
    void dataAccessApi
      .create(nodeId, doc.id, { table_id: tableId, column_id: columnId || null, mode })
      .catch(() => undefined)
      .finally(() => { setColumnId(""); onChanged(); });
  };

  if (!isArchitect && access.length === 0) return null;

  return (
    <div className="dbs-table">
      <div className="dbs-thead">
        <span className="dbs-name dbs-ro">{doc.name}</span>
        {doc.operation && <span className="dbs-schema dbs-ro">{doc.operation}</span>}
      </div>
      {access.length === 0 ? (
        <p className="np-empty">Обращения не описаны</p>
      ) : (
        <div className="dbs-cols">
          {access.map((a) => (
            <div key={a.id} className="dbs-col">
              <span className={`dbs-mode dbs-mode--${a.mode}`}>{MODE_LABEL[a.mode]}</span>
              <span className="dbs-cname dbs-ro">{label(a)}</span>
              {isArchitect && (
                <button type="button" className="dbs-del" title="Убрать обращение"
                  onClick={() => void dataAccessApi.delete(nodeId, doc.id, a.id)
                    .catch(() => undefined).finally(onChanged)}>×</button>
              )}
            </div>
          ))}
        </div>
      )}
      {isArchitect && tables.length > 0 && (
        <div className="dbs-col dbs-addaccess">
          <select className="np-field dbs-fk" value={mode} aria-label="Что делает операция"
            onChange={(e) => setMode(e.target.value === "write" ? "write" : "read")}>
            <option value="read">читает</option>
            <option value="write">пишет</option>
          </select>
          <select className="np-field dbs-cname" value={tableId} aria-label="Таблица"
            onChange={(e) => { setTableId(e.target.value); setColumnId(""); }}>
            <option value="">таблица…</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>{`${t.node_name} · ${t.name}`}</option>
            ))}
          </select>
          <select className="np-field dbs-ctype" value={columnId} aria-label="Колонка"
            disabled={!tableId}
            onChange={(e) => setColumnId(e.target.value)}>
            {/* Колонка необязательна: SELECT * обычен, и требовать точность везде —
                значит получать выдумку (решение пользователя 2026-08-12). */}
            <option value="">вся таблица</option>
            {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button type="button" className="np-addbtn" onClick={add} disabled={!tableId}>
            + Обращение
          </button>
        </div>
      )}
    </div>
  );
}
