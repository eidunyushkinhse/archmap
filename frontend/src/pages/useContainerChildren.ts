// Правила контейнеров: данные узла-контейнера и агрегация его ПОТОМКОВ.
// Контейнер = сервис с детьми (canHaveChildren && has_children); по правилам у
// него НЕТ своей логики/спек/технологии — страница узла и правая панель
// редактора показывают ОБЪЕДИНЕНИЕ данных потомков: схемы логики (с пометкой
// узла-источника), OpenAPI-спеки и уникальные технологии.
//
// Агрегация строится по ВСЕМУ поддереву (дети + внуки + глубже), а не только по
// непосредственным детям: fetch идёт через getDescendants. Непосредственные дети
// выводятся как подмножество потомков (parent_id === nodeId) — они нужны модалке
// «Распределить по детям» и списку «Дети» в инспекторе.
//
// Хук фетчит потомков только если узел — контейнер, и мемоизированно считает
// объединения. Переиспользуется NodePage и NodeInspector.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Node, NodeDocMeta } from "../types";
import { compareByRank } from "../types";
import { nodesApi } from "../api/nodes";

// Схема логики потомка в объединении «Логика» контейнера: мета дока + сам
// узел-источник (для пометки имени и перехода на его страницу). Поле `child`
// исторически зовётся так, но это ЛЮБОЙ потомок-владелец дока (не только
// непосредственный ребёнок).
export interface ContainerChildDoc {
  doc: NodeDocMeta;
  child: Node;
}

export interface ContainerChildrenState {
  // Непосредственные дети (подмножество потомков): null — ещё не загружены (или
  // узел не контейнер), [] — загружены и детей нет. Для модалки распределения и
  // списка «Дети».
  children: Node[] | null;
  // true, пока потомки грузятся (только для контейнера)
  loading: boolean;
  // Доки ВСЕХ потомков одним списком (в порядке compareByRank), с владельцем.
  combinedDocs: ContainerChildDoc[];
  // Потомки с непустой OpenAPI-спекой
  combinedSpecs: Node[];
  // Уникальные непустые технологии потомков через запятую («Python, Kafka»)
  aggTech: string;
  // Перезагрузить потомков (после переноса grandfather-доков/спеки модалкой)
  reload: () => void;
}

export function useContainerChildren(nodeId: string, isContainer: boolean): ContainerChildrenState {
  // ВСЕ потомки (дети + внуки + глубже), без самого узла.
  const [descendants, setDescendants] = useState<Node[] | null>(null);
  // Счётчик перезагрузок: reload() наращивает его, эффект рефетчит потомков.
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    if (!isContainer) return; // не контейнер — потомков не запрашиваем
    let alive = true;
    nodesApi.getDescendants(nodeId)
      // Порядок как в дереве-навигаторе (compareByRank) — стабильный список
      // в объединении доков/спек и в агрегированной технологии.
      .then((ds) => { if (alive) setDescendants([...ds].sort(compareByRank)); })
      .catch(() => { if (alive) setDescendants([]); });
    return () => { alive = false; };
  }, [nodeId, isContainer, seq]);

  const reload = useCallback(() => setSeq((s) => s + 1), []);

  // Непосредственные дети: потомки с parent_id === nodeId.
  const children = useMemo<Node[] | null>(
    () => (descendants === null ? null : descendants.filter((d) => d.parent_id === nodeId)),
    [descendants, nodeId],
  );

  // Объединение доков ВСЕХ потомков: плоский список, помечаем узла-владельца.
  const combinedDocs = useMemo<ContainerChildDoc[]>(() => {
    if (!isContainer || !descendants) return [];
    const out: ContainerChildDoc[] = [];
    for (const d of descendants) {
      for (const doc of d.docs) out.push({ doc, child: d });
    }
    return out;
  }, [isContainer, descendants]);

  // Потомки со спекой: пустая/пробельная спека не считается.
  const combinedSpecs = useMemo<Node[]>(
    () => (isContainer ? (descendants ?? []) : []).filter((d) => (d.openapi_spec ?? "").trim() !== ""),
    [isContainer, descendants],
  );

  // Агрегированная технология: уникальные непустые технологии потомков, через
  // запятую. Порядок — по потомкам (compareByRank выше), дубликаты гасит Set.
  const aggTech = useMemo(() => {
    if (!isContainer || !descendants) return "";
    const seen = new Set<string>();
    for (const d of descendants) {
      const t = (d.technology ?? "").trim();
      if (t !== "") seen.add(t);
    }
    return [...seen].join(", ");
  }, [isContainer, descendants]);

  return {
    children: isContainer ? children : null,
    loading: isContainer && descendants === null,
    combinedDocs,
    combinedSpecs,
    aggTech,
    reload,
  };
}
