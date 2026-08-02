import { useCallback, useState } from "react";
import type { DeletionSnapshot, Node } from "../types";
import { nodesApi } from "../api/nodes";
import { plural } from "../ui/plural";
import ConfirmDialog from "../ui/ConfirmDialog";
import { confirmListBox, confirmList } from "../ui/styles";

/**
 * Подтверждение удаления НЕСКОЛЬКИХ выбранных узлов (мультиудаление с канваса по
 * Backspace/Delete). В отличие от одиночного NodeDeleteConfirm не перечисляет
 * связи каждого узла (их может быть много) — показывает список имён и общее
 * предупреждение, что потомки и связи уйдут каскадом.
 *
 * Узлы уровня — сиблинги (общий родитель), вложенности между ними нет, поэтому
 * снимки и удаления делаем параллельно: ни одно удаление не каскадит другое.
 */

interface Props {
  nodes: Node[];
  onCancel: () => void;
  // snapshots сняты ПЕРЕД удалением (для отката, Undo); порядок совпадает с ids.
  onDeleted: (ids: string[], snapshots: DeletionSnapshot[]) => void;
}

export default function NodesDeleteConfirm({ nodes, onCancel, onDeleted }: Props) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirmDelete = useCallback(async () => {
    setDeleting(true);
    setError(null);
    try {
      const ids = nodes.map((n) => n.id);
      // Снимки снимаем ДО удаления — после каскада восстанавливать будет не из чего.
      const snapshots = await Promise.all(ids.map((id) => nodesApi.deletionSnapshot(id)));
      await Promise.all(ids.map((id) => nodesApi.delete(id)));
      onDeleted(ids, snapshots);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Ошибка удаления");
      setDeleting(false);
    }
  }, [nodes, onDeleted]);

  return (
    <ConfirmDialog
      title={`Удалить ${nodes.length} ${plural(nodes.length, ["объект", "объекта", "объектов"])}?`}
      lead="Будут удалены вместе со своими дочерними объектами и связями:"
      error={error}
      confirmLabel="Да, удалить"
      busyLabel="Удаление..."
      cancelLabel="Нет"
      busy={deleting}
      onConfirm={confirmDelete}
      onCancel={onCancel}
      scroll
    >
      <div style={confirmListBox}>
        <ul style={confirmList}>
          {nodes.map((n) => (
            <li key={n.id} style={{ marginBottom: 4 }}>{n.name}</li>
          ))}
        </ul>
      </div>
    </ConfirmDialog>
  );
}
