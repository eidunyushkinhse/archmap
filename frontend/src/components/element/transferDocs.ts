// Получатели «Перенести документацию» и строки «Собрать с компонентов» (Р19 эпика
// «Элемент архитектуры», docs/plan-c4-elements.md). Элемент каждого потомка сервер
// отдаёт готовым (element_effective) — здесь только отбор и подписи; окончательное
// слово за сервером (app/facts_transfer.py), он отвечает отказом с причиной.
import type { CollectFactsPreview, Node } from "../../types";
import { plural } from "../../ui/plural";

// Потомок в порядке дерева с подписью — путём от узла («orders / api»), без самого узла.
export interface SubtreeRow {
  node: Node;
  label: string;
}

// Потомки в обходе в глубину: братья — в порядке списка (useDescendants сортирует их
// как дерево-навигатор, compareByRank). Потомок без цепочки до узла (данные гонки)
// в список не попадает.
export function subtreeRows(rootId: string, descendants: Node[]): SubtreeRow[] {
  const kids = new Map<string, Node[]>();
  for (const d of descendants) {
    if (d.parent_id === null) continue;
    const list = kids.get(d.parent_id) ?? [];
    list.push(d);
    kids.set(d.parent_id, list);
  }
  const out: SubtreeRow[] = [];
  const seen = new Set<string>([rootId]);
  const walk = (parentId: string, prefix: string) => {
    for (const k of kids.get(parentId) ?? []) {
      if (seen.has(k.id)) continue; // цикл в данных — не зависаем
      seen.add(k.id);
      const label = prefix === "" ? k.name : `${prefix} / ${k.name}`;
      out.push({ node: k, label });
      walk(k.id, label);
    }
  };
  walk(rootId, "");
  return out;
}

// Схемы логики описывают код: их место у компонента (в том числе составного) или у
// сервиса без вложенных вне контейнера. Система и контейнер с компонентами — не
// получатели; база, брокер и «Пользователь» схем логики не держат вовсе.
export function takesLogic(n: Node): boolean {
  if (n.shape !== "service") return false;
  return n.element_effective === "component" || (n.element_effective === "container" && !n.has_children);
}

// Спецификацию и конфигурацию читает запускаемое целиком — контейнер (лист или с
// компонентами).
export function takesProcessFacts(n: Node): boolean {
  return n.shape === "service" && n.element_effective === "container";
}

// Строка компонента в окне сбора: «api · 2 параметра, спецификация».
export function collectLine(c: CollectFactsPreview["components"][number]): string {
  const parts: string[] = [];
  if (c.params > 0) parts.push(`${c.params} ${plural(c.params, ["параметр", "параметра", "параметров"])}`);
  if (c.has_spec) parts.push("спецификация");
  return `${c.name} · ${parts.join(", ")}`;
}

