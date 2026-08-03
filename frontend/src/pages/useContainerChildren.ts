// Правила контейнеров: непосредственные дети узла-контейнера и агрегация их
// данных. Контейнер = сервис с детьми (canHaveChildren && has_children); по
// правилам у него НЕТ своей логики/спек/технологии — страница узла и правая
// панель редактора показывают ОБЪЕДИНЕНИЕ данных детей: схемы логики (с
// пометкой ребёнка-источника), OpenAPI-спеки и уникальные технологии.
// Хук фетчит детей только если узел — контейнер, и мемоизированно считает
// объединения. Переиспользуется NodePage и NodeInspector.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Node, NodeDocMeta } from "../types";
import { compareByRank } from "../types";
import { nodesApi } from "../api/nodes";

// Схема логики ребёнка в объединении «Логика» контейнера: мета дока + сам
// ребёнок-источник (для пометки имени и перехода на страницу ребёнка).
export interface ContainerChildDoc {
  doc: NodeDocMeta;
  child: Node;
}

export interface ContainerChildrenState {
  // Непосредственные дети: null — ещё не загружены (или узел не контейнер),
  // [] — загружены и детей нет (контейнер мог потерять детей в другой сессии)
  children: Node[] | null;
  // true, пока дети грузятся (только для контейнера)
  loading: boolean;
  // Доки всех непосредственных детей одним списком (в порядке детей)
  combinedDocs: ContainerChildDoc[];
  // Дети с непустой OpenAPI-спекой
  combinedSpecs: Node[];
  // Уникальные непустые технологии детей через запятую («Python, Kafka»)
  aggTech: string;
  // Перезагрузить детей (после переноса grandfather-доков/спеки модалкой)
  reload: () => void;
}

export function useContainerChildren(nodeId: string, isContainer: boolean): ContainerChildrenState {
  const [children, setChildren] = useState<Node[] | null>(null);
  // Счётчик перезагрузок: reload() наращивает его, эффект рефетчит детей.
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    if (!isContainer) return; // не контейнер — детей не запрашиваем
    let alive = true;
    nodesApi.getChildren(nodeId)
      // Порядок как в дереве-навигаторе (compareByRank) — стабильный список
      // в объединении доков/спек и в агрегированной технологии.
      .then((cs) => { if (alive) setChildren([...cs].sort(compareByRank)); })
      .catch(() => { if (alive) setChildren([]); });
    return () => { alive = false; };
  }, [nodeId, isContainer, seq]);

  const reload = useCallback(() => setSeq((s) => s + 1), []);

  // Объединение доков: плоский список по детям (внучатые НЕ входят — только
  // непосредственные дети). Помечаем каждого ребёнка-источника.
  const combinedDocs = useMemo<ContainerChildDoc[]>(() => {
    if (!isContainer || !children) return [];
    const out: ContainerChildDoc[] = [];
    for (const child of children) {
      for (const doc of child.docs) out.push({ doc, child });
    }
    return out;
  }, [isContainer, children]);

  // Дети со спекой: пустая/пробельная спека не считается.
  const combinedSpecs = useMemo<Node[]>(
    () => (isContainer ? (children ?? []) : []).filter((c) => (c.openapi_spec ?? "").trim() !== ""),
    [isContainer, children],
  );

  // Агрегированная технология: уникальные непустые технологии детей, через
  // запятую. Порядок — по детям (compareByRank выше), дубликаты гасит Set.
  const aggTech = useMemo(() => {
    if (!isContainer || !children) return "";
    const seen = new Set<string>();
    for (const c of children) {
      const t = (c.technology ?? "").trim();
      if (t !== "") seen.add(t);
    }
    return [...seen].join(", ");
  }, [isContainer, children]);

  return {
    children: isContainer ? children : null,
    loading: isContainer && children === null,
    combinedDocs,
    combinedSpecs,
    aggTech,
    reload,
  };
}
