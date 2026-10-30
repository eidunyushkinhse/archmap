import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { nodesApi } from "../api/nodes";
import type { Node } from "../types";
import { compareByRank } from "../types";

// Узлы уровня в порядке показа (ранг формы, затем имя). Персоны стоят в общей
// иерархии наравне с прочими.
const sortNodes = (ns: Node[]): Node[] => ns.sort(compareByRank);

export interface LazyTree {
  roots: Node[];
  loadingRoots: boolean;
  // Загруженные дети по id родителя (отсутствие ключа = ещё не грузили).
  childrenById: Record<string, Node[]>;
  expanded: Set<string>;
  loadingId: Set<string>;
  // Узлы с has_children без видимых детей — показываем листьями: детей не пришло (шеврон
  // не раскрывался бы в пустоту) или их дети в этом режиме скрыты (hideChildren).
  leaves: Set<string>;
  // Все загруженные узлы по id (корни + подгруженные дети). Чтобы узел был виден в
  // дереве, все его предки раскрыты — значит, их Node-объекты уже здесь.
  allById: Map<string, Node>;
  // Путь от корня до узла включительно (по цепочке parent_id среди загруженных узлов).
  pathTo: (node: Node) => Node[];
  // Раскрыть ветку (дети подгружаются лениво). Идемпотентна: раскрытую не сворачивает.
  expandBranch: (node: Node) => Promise<void>;
  // Клик по шеврону: раскрыть/свернуть.
  toggle: (node: Node) => Promise<void>;
  // Контейнер списка — для прокрутки к строке текущего узла (.nt-row--current).
  treeScrollRef: RefObject<HTMLDivElement | null>;
}

// Ленивое дерево объектов (аудит F-7): корни сразу, дети — по раскрытию ветки. Сигнал
// reloadToken перечитывает корни и раскрытые ветки, не сворачивая их; смена
// currentNodeId раскрывает ветку до этого узла и прокручивает к его строке.
// hideChildren — у каких узлов детей в этом режиме не показывать («Развёртывание»
// прячет компоненты, nodeTree NodeTreePanel): такие узлы — листья, их дети не грузятся.
// Ссылка должна быть стабильной (функция модуля), иначе мемо листьев пересчитывается.
export function useLazyTree(
  reloadToken: number | undefined,
  currentNodeId: string | null | undefined,
  hideChildren?: (node: Node) => boolean,
): LazyTree {
  const [roots, setRoots] = useState<Node[]>([]);
  const [loadingRoots, setLoadingRoots] = useState(true);
  const [childrenById, setChildrenById] = useState<Record<string, Node[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingId, setLoadingId] = useState<Set<string>>(new Set());
  // Листья по факту загрузки (детей не пришло); вместе со скрытыми режимом — leaves ниже.
  const [emptyLeaves, setLeaves] = useState<Set<string>>(new Set());

  const allById = useMemo(() => {
    const m = new Map<string, Node>();
    for (const r of roots) m.set(r.id, r);
    for (const kids of Object.values(childrenById)) for (const k of kids) m.set(k.id, k);
    return m;
  }, [roots, childrenById]);

  // Листья для показа: пустые по загрузке и те, чьих детей режим не показывает.
  const leaves = useMemo(() => {
    if (!hideChildren) return emptyLeaves;
    const out = new Set(emptyLeaves);
    for (const n of allById.values()) if (hideChildren(n)) out.add(n.id);
    return out;
  }, [emptyLeaves, allById, hideChildren]);

  const pathTo = (node: Node): Node[] => {
    const path: Node[] = [];
    const seen = new Set<string>();
    let cur: Node | undefined = node;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.unshift(cur);
      cur = cur.parent_id ? allById.get(cur.parent_id) : undefined;
    }
    return path;
  };

  useEffect(() => {
    let alive = true;
    nodesApi
      .list(null)
      .then((ns) => { if (alive) setRoots(sortNodes(ns)); })
      .finally(() => { if (alive) setLoadingRoots(false); });
    return () => { alive = false; };
  }, []);

  // Перезагрузка по внешнему сигналу (создан/удалён узел): перечитываем корни и
  // детей УЖЕ раскрытых веток, чтобы новый узел появился без сворачивания дерева.
  // Путь к нему не разворачиваем — если его родитель свёрнут, у того лишь появится
  // шеврон. Раскрытые ветки берутся на момент сигнала (эффект-событие читает свежие).
  const reloadExpanded = useEffectEvent(async (isAlive: () => boolean) => {
    const ns = sortNodes(await nodesApi.list(null));
    if (!isAlive()) return;
    setRoots(ns);
    const fetched = await Promise.all(
      [...expanded].map((id) =>
        nodesApi.getChildren(id)
          .then((k) => [id, sortNodes(k)] as const)
          .catch(() => [id, [] as Node[]] as const),
      ),
    );
    if (!isAlive()) return;
    setChildrenById((prev) => {
      const next = { ...prev };
      for (const [id, kids] of fetched) next[id] = kids;
      return next;
    });
  });
  const reloadSkipRef = useRef(false);
  useEffect(() => {
    // первый прогон — это монтирование; корни грузит эффект выше, повтор не нужен
    if (!reloadSkipRef.current) { reloadSkipRef.current = true; return; }
    let alive = true;
    void reloadExpanded(() => alive);
    return () => { alive = false; };
  }, [reloadToken]);

  // При смене текущего узла раскрываем ветку до него: обход вверх через nodesApi.get
  // (parent_id) собирает цепочку предков, затем сверху вниз догружаем детей каждого
  // предка (тем же путём, что и toggle) и раскрываем их. Ленивая загрузка дерева при
  // этом сохраняется — тянем только нужную ветку. Загруженное читается на момент смены
  // (свежесть не критична: промах по кэшу = лишний fetch, не некорректность).
  const revealTo = useEffectEvent(async (targetId: string, isAlive: () => boolean) => {
    // 1. Цепочка id от корня до текущего узла (включительно).
    const chain: string[] = [];
    const guard = new Set<string>();
    let curId: string | null = targetId;
    while (curId && !guard.has(curId)) {
      guard.add(curId);
      chain.unshift(curId);
      const n: Node = allById.get(curId) ?? (await nodesApi.get(curId));
      if (!isAlive()) return;
      curId = n.parent_id;
    }
    // 2. Предки (все, кроме самого узла) — раскрыть сверху вниз. Ветку, чьих детей режим
    // не показывает, не раскрываем (и глубже не идём).
    for (const id of chain.slice(0, -1)) {
      if (!isAlive()) return;
      const anc = allById.get(id);
      if (anc && hideChildren?.(anc)) return;
      let kids = childrenById[id];
      if (kids === undefined) {
        // Фиксируем в const: TS не сужает let-переменную внутри замыкания
        const fetched = sortNodes(await nodesApi.getChildren(id));
        if (!isAlive()) return;
        setChildrenById((p) => ({ ...p, [id]: fetched }));
        kids = fetched;
      }
      if (kids.length > 0) setExpanded((p) => new Set(p).add(id));
      else setLeaves((p) => new Set(p).add(id));
    }
  });
  useEffect(() => {
    if (!currentNodeId) return;
    let alive = true;
    // Раскрытие — ответ на внешнее событие (сменилась страница), а не производное
    // состояние. Когда вся цепочка уже загружена, setState идёт синхронно, до первого
    // await, — один лишний рендер, как и прежде, когда это был async-IIFE в эффекте.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void revealTo(currentNodeId, () => alive);
    return () => { alive = false; };
  }, [currentNodeId]);

  // Скролл к подсвеченной строке — когда узел стал видим (после автораскрытия).
  // Повторяем на изменениях expanded/childrenById, пока строка не появится; скроллим
  // один раз на узел (scrolledToRef).
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const scrolledToRef = useRef<string | null>(null);
  useEffect(() => {
    if (!currentNodeId) { scrolledToRef.current = null; return; }
    if (scrolledToRef.current === currentNodeId) return;
    const raf = requestAnimationFrame(() => {
      const el = treeScrollRef.current?.querySelector(".nt-row--current");
      if (el) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        scrolledToRef.current = currentNodeId;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [currentNodeId, expanded, childrenById]);

  async function expandBranch(node: Node) {
    const id = node.id;
    if (expanded.has(id)) return;
    // Дети скрыты режимом — ни загрузки, ни раскрытия.
    if (hideChildren?.(node)) return;
    let kids = childrenById[id];
    if (kids === undefined) {
      setLoadingId((p) => new Set(p).add(id));
      try {
        // Фиксируем в const: TS не сужает let-переменную внутри замыкания
        const fetched = sortNodes(await nodesApi.getChildren(id));
        setChildrenById((p) => ({ ...p, [id]: fetched }));
        kids = fetched;
      } finally {
        setLoadingId((p) => { const n = new Set(p); n.delete(id); return n; });
      }
    }
    // Детей не пришло (флаг has_children устарел) — помечаем узел листом.
    if (kids.length === 0) {
      setLeaves((p) => new Set(p).add(id));
      return;
    }
    setExpanded((p) => new Set(p).add(id));
  }

  async function toggle(node: Node) {
    if (expanded.has(node.id)) {
      setExpanded((p) => { const n = new Set(p); n.delete(node.id); return n; });
      return;
    }
    await expandBranch(node);
  }

  return {
    roots, loadingRoots, childrenById, expanded, loadingId, leaves, allById, pathTo,
    expandBranch, toggle, treeScrollRef,
  };
}
