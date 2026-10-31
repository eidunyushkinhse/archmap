// Строки окна «Собрать с компонентов» (Р19 эпика «Элемент архитектуры»,
// docs/plan-c4-elements.md). Получателей «Перенести документацию» здесь больше нет: их
// с флагами по семьям фактов отдаёт сервер (nodesApi.transferPreview,
// app/facts_transfer.py), окно их только показывает.
import type { CollectFactsPreview } from "../../types";
import { plural } from "../../ui/plural";

// Строка компонента в окне сбора: «api · 2 параметра, спецификация».
export function collectLine(c: CollectFactsPreview["components"][number]): string {
  const parts: string[] = [];
  if (c.params > 0) parts.push(`${c.params} ${plural(c.params, ["параметр", "параметра", "параметров"])}`);
  if (c.has_spec) parts.push("спецификация");
  return `${c.name} · ${parts.join(", ")}`;
}
