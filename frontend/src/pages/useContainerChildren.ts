// Правила контейнеров: данные узла-контейнера и агрегация его ПОТОМКОВ.
// Контейнер = сервис с детьми (canHaveChildren && has_children); по правилам у
// него НЕТ своей логики/спек/технологии — страница узла показывает ОБЪЕДИНЕНИЕ
// данных потомков: схемы логики, OpenAPI-спеки (с пометкой узла-источника) и
// уникальные технологии.
//
// Агрегация строится по ВСЕМУ поддереву (дети + внуки + глубже), а не только по
// непосредственным детям: fetch идёт через getDescendants. Данные ГРУППИРУЮТСЯ
// по непосредственным детям контейнера: доки/спеки самого ребёнка идут плоско
// (own), а доки/спеки более глубоких потомков — в раскрываемую группу (deep)
// под их ближайшим предком, который является непосредственным ребёнком.
// Непосредственные дети выводятся как подмножество потомков
// (parent_id === nodeId) — они нужны модалке «Распределить по детям».
//
// Хук фетчит потомков только если узел — контейнер, и мемоизированно считает
// группы. Переиспользуется NodePage.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Node, NodeDocMeta } from "../types";
import { compareByRank } from "../types";
import { nodesApi } from "../api/nodes";

// Док в объединении: мета + узел-владелец (для пометки «от X» и перехода).
export interface ContainerChildDoc {
  doc: NodeDocMeta;
  child: Node;
}

// Группа непосредственного ребёнка для раздела «Логика».
export interface ContainerDocGroup {
  child: Node;                 // непосредственный ребёнок контейнера (якорь группы)
  own: NodeDocMeta[];          // собственные доки ребёнка (показываются плоско)
  deep: ContainerChildDoc[];   // доки более глубоких потомков (группа с шевроном)
}

// Группа непосредственного ребёнка для раздела «OpenAPI».
export interface ContainerSpecGroup {
  child: Node;                 // непосредственный ребёнок (якорь группы)
  own: boolean;                // у самого ребёнка есть спека (плоская кнопка)
  deep: Node[];                // более глубокие потомки со спекой (группа; каждый — владелец)
}

export interface ContainerChildrenState {
  // Непосредственные дети (подмножество потомков): null — ещё не загружены (или
  // узел не контейнер), [] — загружены и детей нет. Для модалки распределения.
  children: Node[] | null;
  // true, пока потомки грузятся (только для контейнера)
  loading: boolean;
  // Схемы логики потомков, сгруппированные по непосредственным детям
  docGroups: ContainerDocGroup[];
  // OpenAPI-спеки потомков, сгруппированные по непосредственным детям
  specGroups: ContainerSpecGroup[];
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
      // Порядок как в дереве-навигаторе (compareByRank) — стабильный порядок
      // групп и записей внутри них, а также агрегированной технологии.
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

  // Группировка доков/спек по непосредственным детям. Якорь потомка d —
  // непосредственный ребёнок контейнера, в чьём поддереве лежит d: подъём по
  // parent_id до parent_id === nodeId (сам непосредственный ребёнок — свой якорь).
  // own — данные самого якоря (плоские), deep — данные глубоких потомков (группа).
  const groups = useMemo<{ docGroups: ContainerDocGroup[]; specGroups: ContainerSpecGroup[] }>(() => {
    if (!isContainer || !descendants) return { docGroups: [], specGroups: [] };

    // Карта id → узел для подъёма по parent_id.
    const byId = new Map<string, Node>(descendants.map((d) => [d.id, d]));
    // Непосредственные дети (descendants уже отсортированы compareByRank):
    // их порядок задаёт порядок групп.
    const direct = descendants.filter((d) => d.parent_id === nodeId);

    const docByAnchor = new Map<string, ContainerDocGroup>();
    const specByAnchor = new Map<string, ContainerSpecGroup>();
    for (const child of direct) {
      docByAnchor.set(child.id, { child, own: [], deep: [] });
      specByAnchor.set(child.id, { child, own: false, deep: [] });
    }

    const anchorOf = (d: Node): Node | null => {
      let cur = d;
      // Защита от зацикливания на битых данных: глубина не больше числа потомков.
      for (let step = 0; cur.parent_id !== nodeId; step++) {
        if (cur.parent_id === null || step > descendants.length) return null;
        const parent = byId.get(cur.parent_id);
        if (!parent) return null; // родитель не найден — потомок пропускается
        cur = parent;
      }
      return cur;
    };

    for (const d of descendants) {
      const anchor = anchorOf(d);
      if (!anchor) continue;
      const dg = docByAnchor.get(anchor.id);
      const sg = specByAnchor.get(anchor.id);
      if (!dg || !sg) continue;
      const isSelf = d.id === anchor.id;
      // Заглушки разведки (схемы без тела) в объединение не идут: бэклог
      // документирования живёт на странице владельца (блок «Не описано»), а
      // витрина контейнера — только описанные схемы потомков.
      for (const doc of d.docs) {
        if (!doc.described) continue;
        if (isSelf) dg.own.push(doc);
        else dg.deep.push({ doc, child: d });
      }
      // Спека считается только непустая
      if ((d.openapi_spec ?? "").trim() !== "") {
        if (isSelf) sg.own = true;
        else sg.deep.push(d);
      }
    }

    // Пустые группы не показываем; порядок — порядок непосредственных детей.
    const docGroups: ContainerDocGroup[] = [];
    const specGroups: ContainerSpecGroup[] = [];
    for (const child of direct) {
      const dg = docByAnchor.get(child.id);
      if (dg && (dg.own.length > 0 || dg.deep.length > 0)) docGroups.push(dg);
      const sg = specByAnchor.get(child.id);
      if (sg && (sg.own || sg.deep.length > 0)) specGroups.push(sg);
    }
    return { docGroups, specGroups };
  }, [isContainer, descendants, nodeId]);

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
    docGroups: groups.docGroups,
    specGroups: groups.specGroups,
    aggTech,
    reload,
  };
}
