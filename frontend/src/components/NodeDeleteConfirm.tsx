import { useCallback, useEffect, useState } from "react";
import type { DeletionSnapshot, Node, NodeEdgeInfo } from "../types";
import { nodesApi } from "../api/nodes";
import { plural } from "../ui/plural";
import ConfirmDialog from "../ui/ConfirmDialog";
import "../ui/ds.css";

/**
 * Подтверждение удаления узла со списком того, что исчезнет вместе с ним: связи
 * поддерева и ДОКУМЕНТАЦИЯ (схемы логики, таблицы БД с колонками, каналы брокера
 * с полями — всё это уносит БД-каскад). Единый источник предупреждения:
 * используется и из NodeModal (кнопка «Удалить»), и при удалении узла с канваса
 * по Backspace/Delete.
 *
 * Снимок для отката снимаем ПРИ ОТКРЫТИИ, а не при подтверждении: он и есть
 * перечень уезжающего, поэтому пользователь видит ровно то, что вернёт Ctrl+Z.
 * Удаление идёт сразу за подтверждением в модальном окне — разъехаться нечему.
 *
 * Если терять нечего — узел без внешних связей, без детей и без документации —
 * удаляем сразу, без модалки. Прежде документация в это «нечего» не входила, и
 * задокументированная база без связей уезжала вообще без предупреждения. Пока
 * данные грузятся, компонент ничего не рисует, чтобы модалка не мелькала.
 */

interface Props {
  node: Node;
  onCancel: () => void;
  // snapshot — снимок поддерева, снятый ПЕРЕД удалением; нужен для отката (Undo).
  onDeleted: (id: string, snapshot: DeletionSnapshot) => void;
}

// Что из документации уедет вместе с поддеревом — перечисление для человека.
// Пусто (null), если документации нет: тогда и говорить не о чем.
function docsSummary(snap: DeletionSnapshot): string | null {
  const parts: string[] = [];
  const docs = snap.node_docs.length;
  const tables = snap.db_tables.length;
  const columns = snap.db_columns.length;
  const channels = snap.broker_channels.length;
  const fields = snap.channel_fields.length;
  if (docs > 0) parts.push(`${docs} ${plural(docs, ["схема логики", "схемы логики", "схем логики"])}`);
  if (tables > 0) {
    const cols = columns > 0 ? `, в них ${columns} ${plural(columns, ["колонка", "колонки", "колонок"])}` : "";
    parts.push(`${tables} ${plural(tables, ["таблица БД", "таблицы БД", "таблиц БД"])}${cols}`);
  }
  if (channels > 0) {
    const flds = fields > 0 ? `, в них ${fields} ${plural(fields, ["поле", "поля", "полей"])}` : "";
    parts.push(`${channels} ${plural(channels, ["канал брокера", "канала брокера", "каналов брокера"])}${flds}`);
  }
  return parts.length > 0 ? `Вместе с ним удалится документация: ${parts.join("; ")}.` : null;
}

// Строка перечня связей: подпись (или технология) в кавычках и второй конец. У связи без
// подписи и технологии кавычек нет: «связь» здесь слово, а не подпись.
function edgeLine(e: NodeEdgeInfo): string {
  const lbl = e.label || e.technology;
  const dir = e.direction === "outgoing" ? "к" : "от";
  return lbl ? `«${lbl}» ${dir} ${e.other_node_name}` : `связь ${dir} ${e.other_node_name}`;
}

export default function NodeDeleteConfirm({ node, onCancel, onDeleted }: Props) {
  const [edges, setEdges] = useState<NodeEdgeInfo[] | null>(null); // null — ещё грузим
  const [snapshot, setSnapshot] = useState<DeletionSnapshot | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = useCallback(
    async (snap: DeletionSnapshot) => {
      setDeleting(true);
      setError(null);
      try {
        await nodesApi.delete(node.id);
        onDeleted(node.id, snap);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Ошибка удаления");
        setDeleting(false);
      }
    },
    [node.id, onDeleted],
  );

  // Тянем внешние связи поддерева и снимок удаления. Если терять нечего — удаляем
  // сразу, без подтверждения; иначе показываем модалку с перечнем.
  useEffect(() => {
    let alive = true;
    Promise.all([nodesApi.getEdges(node.id), nodesApi.deletionSnapshot(node.id)])
      .then(([es, snap]) => {
        if (!alive) return;
        if (es.length === 0 && !node.has_children && docsSummary(snap) === null) {
          void confirmDelete(snap);
        } else {
          setEdges(es);
          setSnapshot(snap);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setError(e instanceof Error ? e.message : "Не удалось получить связи объекта");
        }
      });
    return () => { alive = false; };
  }, [node.id, node.has_children, confirmDelete]);

  // Пока грузим или сразу удаляем узел, которому нечего терять — ничего не
  // показываем (модалка не должна мелькать на таких узлах).
  if (edges === null && !error) return null;

  const hasEdges = edges !== null && edges.length > 0;
  const lead = hasEdges
    ? (node.has_children
        ? "Объект и его дочерние объекты будут удалены. Вместе с ними удалятся связи:"
        : "Его связи будут удалены вместе с ним:")
    : (node.has_children ? "Объект и все его дочерние объекты будут удалены." : undefined);
  const docsLine = snapshot ? docsSummary(snapshot) : null;

  return (
    <ConfirmDialog
      title={`Удалить «${node.name}»?`}
      lead={lead}
      error={error}
      confirmLabel="Удалить"
      busyLabel="Удаляем"
      busy={deleting}
      onConfirm={() => { if (snapshot) void confirmDelete(snapshot); }}
      onCancel={onCancel}
    >
      {edges !== null && edges.length > 0 && (
        <ul className="ds-confirm-list">
          {edges.map((e) => {
            const text = edgeLine(e);
            return <li key={e.id} title={text}>{text}</li>;
          })}
        </ul>
      )}
      {docsLine && <p className="ds-confirm-note">{docsLine}</p>}
    </ConfirmDialog>
  );
}
