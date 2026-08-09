import type { NodeDoc, NodeDocMeta } from "../../types";

// Мета дока (без content) — для стейта узла: имя/вид/операция/версия. Версия
// входит в сигнатуру меты поллинга (V53): правка КОНТЕНТА доков видна странице
// как изменение данных даже без смены имени/вида.
export function docToMeta(d: NodeDoc): NodeDocMeta {
  return { id: d.id, name: d.name, kind: d.kind, operation: d.operation, version: d.version };
}
