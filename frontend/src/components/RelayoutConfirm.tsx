import { useCallback, useState } from "react";
import { nodesApi } from "../api/nodes";
import ConfirmDialog from "../ui/ConfirmDialog";

/**
 * Подтверждение команды «Переразложить уровень» (own-on-first-render, Ф2).
 *
 * Стирает позиции в строках вида текущего уровня (позиции локальных узлов и
 * гостей, геометрию пучков) — уровень возвращается к авто-виду (ELK + кольца +
 * авто-маршруты), как при первом открытии. Раскрытия контейнеров ПЕРЕЖИВАЮТ
 * сброс (строки с флагом expanded сохраняются, решение 2026-08-05). Действие
 * необратимо (отдельного Undo нет; вся история чистится), поэтому подтверждаем
 * модалкой.
 */

interface Props {
  // Уровень, который переразложить: containerId узла или null для корня.
  containerId: string | null;
  // Человекочитаемое имя уровня (для заголовка); пусто/undefined — корень схемы.
  levelName?: string;
  onCancel: () => void;
  // Сброс выполнен на бэкенде — родитель перезагружает уровень и чистит историю.
  onDone: () => void;
}

export default function RelayoutConfirm({ containerId, levelName, onCancel, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await nodesApi.relayoutLevel(containerId);
      onDone();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось переразложить уровень");
      setBusy(false);
    }
  }, [containerId, onDone]);

  const where = levelName ? `«${levelName}»` : "корневой схемы";

  return (
    <ConfirmDialog
      title={`Переразложить уровень ${where}?`}
      lead="Все ручные правки расположения на этом уровне будут сброшены к авто-раскладке: позиции узлов, точки стыковки и изломы стрелок. Раскрытые контейнеры останутся раскрытыми, их дети разложатся заново. Действие нельзя отменить."
      error={error}
      confirmLabel="Да, переразложить"
      busyLabel="Сброс..."
      busy={busy}
      onConfirm={confirm}
      onCancel={onCancel}
    />
  );
}
