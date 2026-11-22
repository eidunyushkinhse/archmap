import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Edge, Node } from "../types";
import { compareByRank } from "../types";
import Modal from "../ui/Modal";
import { CheckIcon, ChevronIcon, CloseIcon, SwapIcon } from "../ui/icons";
import { LimitText } from "./demo/DemoLimitToast";
import { useEdgeCreate } from "./useEdgeCreate";
import { noAutofill } from "../ui/noAutofill";
import "../ui/ds.css";
import "./edgeWindows.css";

interface Props {
  title: string;
  // Узел, от которого протянули стрелку (ближний конец связи). Хэндл жеста связь
  // больше не несёт (R3): геометрию пучка display-пары сохраняет MapEditorPage после
  // onCreated (направление выводит из created.source_id).
  sourceId: string;
  sourceLabel: string;
  // плоский список узлов-кандидатов; дерево собирается из него по parent_id
  loadNodes: () => Promise<Node[]>;
  // ключ скоупа (для перезагрузки при смене источника данных)
  scopeKey: string;
  // корни дерева = узлы с этим parent_id; pathOf останавливается на нём.
  // null — корни всей схемы (parent_id == null).
  rootParentId: string | null;
  // узлы, которые нельзя выбрать (greyed, не считаются совпадениями) — в т.ч. сам источник
  excludeIds?: Set<string>;
  // подпись пустого слота цели (различает жесты: «вне уровня» / «внутрь контейнера»)
  slotPlaceholder: string;
  onClose: () => void;
  // created — созданная связь (для отката создания через Undo в MapEditorPage).
  onCreated: (created: Edge) => void;
}

/**
 * Окно выбора дальнего конца межуровневой связи (редизайн, фаза 9в: каркас окна нового
 * языка ui/ds.css, ds-win). Под заголовком строка «маршрута»: источник обычным текстом,
 * соединитель с наконечником у цели связи и кнопкой разворота, слот цели. Ниже поиск и
 * дерево объектов-кандидатов (собирается на клиенте из плоского списка по parent_id), под
 * ним строки «Описание» и «Технология». Один компонент для двух жестов: «связь внутрь
 * контейнера» (скоуп — поддерево, rootParentId = контейнер) и «связь к объекту вне
 * уровня» (скоуп — вся схема, rootParentId = null, недоступные объекты в excludeIds).
 * Поиск фильтрует дерево на месте (совпадения и их предки, ветки к ним раскрыты), а не
 * открывает отдельный список. Направление по умолчанию — от источника к цели; кнопка на
 * соединителе разворачивает его, не меняя элементы местами (источник всегда слева,
 * направление видно по стороне наконечника).
 *
 * Окно прижато к верху, как «Новый объект» (NodeModal: отступ 8vh, ds-win--top): поиск и
 * раскрытие веток меняют высоту дерева, и окно по центру прыгало бы верхним краем.
 */
export default function CrossLevelEdgePicker({
  title, sourceId, sourceLabel,
  loadNodes, scopeKey, rootParentId, excludeIds, slotPlaceholder, onClose, onCreated,
}: Props) {
  const uid = useId();
  const [allNodes, setAllNodes] = useState<Node[] | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Node | null>(null);
  // раскрытые узлы дерева (по умолчанию свёрнуто — видны только прямые дети корня)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // "out" — связь sourceId→выбранный (по умолчанию); "in" — выбранный→sourceId
  const [direction, setDirection] = useState<"out" | "in">("out");
  const { label, setLabel, technology, setTechnology, saving, error, setError, limit, create } =
    useEdgeCreate(onCreated);
  // прокрутка к выбранной строке после выбора из поиска
  const pickedRowRef = useRef<HTMLDivElement | null>(null);

  const excluded = useMemo(() => (id: string) => excludeIds?.has(id) ?? false, [excludeIds]);

  useEffect(() => {
    let cancelled = false;
    loadNodes()
      .then((d) => { if (!cancelled) setAllNodes(d); })
      .catch(() => { if (!cancelled) { setAllNodes([]); setError("Не удалось загрузить объекты"); } });
    return () => { cancelled = true; };
    // loadNodes — нестабильная ссылка из родителя; перезагружаем по scopeKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // Индексы для дерева: узел по id и дети по parent_id.
  const byId = useMemo(() => {
    const m = new Map<string, Node>();
    for (const n of allNodes ?? []) m.set(n.id, n);
    return m;
  }, [allNodes]);
  const childrenOf = useMemo(() => {
    const m = new Map<string, Node[]>();
    for (const n of allNodes ?? []) {
      if (!n.parent_id) continue;
      const arr = m.get(n.parent_id);
      if (arr) arr.push(n); else m.set(n.parent_id, [n]);
    }
    for (const arr of m.values()) arr.sort(compareByRank);
    return m;
  }, [allNodes]);
  // Корни дерева — узлы с parent_id == rootParentId (для «вне уровня» это корни схемы).
  const roots = useMemo(
    () =>
      (allNodes ?? [])
        .filter((n) => (n.parent_id ?? null) === rootParentId)
        .sort(compareByRank),
    [allNodes, rootParentId],
  );

  const q = query.trim().toLowerCase();
  const filtering = q.length > 0;

  // Фильтр дерева: при непустом запросе видимы узлы-совпадения и все их предки
  // (ветки к совпадениям авто-раскрыты). expanded НЕ мутируем — это производное
  // отображение. null = фильтр выключен (показываем обычное дерево по expanded).
  const visibleIds = useMemo<Set<string> | null>(() => {
    if (!filtering) return null;
    const ids = new Set<string>();
    for (const n of allNodes ?? []) {
      if (excluded(n.id) || !n.name.toLowerCase().includes(q)) continue;
      ids.add(n.id);
      let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
      while (cur && cur.id !== rootParentId) {
        ids.add(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
    }
    return ids;
  }, [allNodes, q, filtering, excluded, byId, rootParentId]);

  // Путь от корня скоупа до узла (без него самого) — тихий префикс имени в слоте.
  const pathOf = (n: Node): string => {
    const parts: string[] = [];
    let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
    while (cur && cur.id !== rootParentId) {
      parts.unshift(cur.name);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return parts.join(" / ");
  };

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });

  // Выбор узла: фиксируем, чистим поиск и раскрываем путь к нему (чтобы после
  // очистки фильтра строка осталась видна в обычном дереве).
  const selectNode = (n: Node) => {
    setPicked(n);
    if (query) setQuery("");
    setExpanded((prev) => {
      const s = new Set(prev);
      let cur = n.parent_id ? byId.get(n.parent_id) : undefined;
      while (cur && cur.id !== rootParentId) {
        s.add(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
      return s;
    });
  };

  // Прокрутить выбранную строку в зону видимости (после выбора из поиска).
  useEffect(() => {
    pickedRowRef.current?.scrollIntoView({ block: "nearest" });
  }, [picked]);

  // Подсветка совпавшего фрагмента имени (только при активном фильтре).
  const highlight = (name: string): ReactNode => {
    if (!filtering) return name;
    const idx = name.toLowerCase().indexOf(q);
    if (idx === -1) return name;
    return (
      <>
        {name.slice(0, idx)}
        <mark className="clp-mark">{name.slice(idx, idx + q.length)}</mark>
        {name.slice(idx + q.length)}
      </>
    );
  };

  const renderNode = (n: Node, depth: number): ReactElement | null => {
    // В режиме фильтра показываем только узлы из visibleIds (совпадения + предки).
    if (visibleIds && !visibleIds.has(n.id)) return null;
    const kids = childrenOf.get(n.id) ?? [];
    const visibleKids = visibleIds ? kids.filter((k) => visibleIds.has(k.id)) : kids;
    const showChev = visibleKids.length > 0;
    const isOpen = visibleIds ? true : expanded.has(n.id);
    const isPicked = picked?.id === n.id;
    const isExcluded = excluded(n.id);
    return (
      <div key={n.id}>
        <div
          ref={isPicked ? pickedRowRef : undefined}
          className={"clp-row" + (isPicked ? " is-picked" : "") + (isExcluded ? " is-off" : "")}
          // Отступ вложенности — от глубины: 16px на уровень.
          style={{ paddingLeft: 8 + depth * 16 }}
          // Недоступный узел (текущего уровня / источник) не выбираем, но дерево
          // оставляем проходимым — его потомки могут быть валидными целями.
          onClick={() => { if (!isExcluded) selectNode(n); }}
        >
          {showChev ? (
            <button
              type="button"
              className={"clp-chev" + (isOpen ? " is-open" : "")}
              onClick={(e) => { e.stopPropagation(); toggle(n.id); }}
              title={isOpen ? "Свернуть" : "Развернуть"}
              aria-expanded={isOpen}
            >
              <ChevronIcon size={12} />
            </button>
          ) : (
            <span className="clp-leaf" aria-hidden="true" />
          )}
          <span className="clp-name">
            {highlight(n.name)}
            {n.role && <span className="clp-quiet">{n.role}</span>}
            {isExcluded && <span className="clp-quiet">на этом уровне</span>}
          </span>
          {isPicked && <span className="clp-check"><CheckIcon /></span>}
        </div>
        {isOpen && visibleKids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  async function handleCreate() {
    if (!picked) {
      setError("Выберите объект");
      return;
    }
    if (picked.id === sourceId) {
      setError("Объект не может ссылаться сам на себя");
      return;
    }
    await create(
      direction === "out" ? sourceId : picked.id,
      direction === "out" ? picked.id : sourceId,
    );
  }

  const pickedPath = picked ? pathOf(picked) : "";
  // Enter в любом поле окна — как «Создать связь»; пока конец не выбран или идёт
  // создание, кнопка неактивна, и клавиша молчит так же.
  const canCreate = picked !== null && !saving;
  const submit = () => { if (canCreate) void handleCreate(); };

  return (
    <Modal onClose={onClose} onSubmit={submit} closeButton={false} boxStyle={{ width: 480, padding: 0, margin: "8vh auto auto" }}>
      <div className="ds ds-win ds-win--top">
        <div className="ds-win-head">
          <h2 className="ds-win-title">{title}</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          {/* Маршрут: источник ——соединитель——> слот цели. Позиции фиксированы (источник
              всегда слева); направление показывает только сторона наконечника. */}
          <div className="clp-route">
            <span className="clp-src" title={sourceLabel}>{sourceLabel}</span>
            <div className="clp-conn">
              {direction === "in" && <Head dir="left" />}
              <span className="clp-conn-line" />
              {direction === "out" && <Head dir="right" />}
              <button
                type="button"
                className="ds-icon-btn clp-swap"
                onClick={() => setDirection((d) => (d === "out" ? "in" : "out"))}
                title="Поменять направление"
                aria-label="Поменять направление"
              >
                <SwapIcon />
              </button>
            </div>
            {picked ? (
              // Выбранная цель — значение-кнопка: щелчок снимает выбор. Путь к ней — тихим
              // префиксом, он и обрезается первым: черта и имя видны всегда.
              <button type="button" className="ds-value-btn clp-slot" onClick={() => setPicked(null)} title="Снять выбор">
                {pickedPath && (
                  <>
                    <span className="clp-slot-path">{pickedPath}</span>
                    <span className="clp-slot-sep">{" / "}</span>
                  </>
                )}
                <span className="clp-slot-name">{picked.name}</span>
              </button>
            ) : (
              <span className="clp-slot ds-empty">{slotPlaceholder}</span>
            )}
          </div>

          {/* Поиск фильтрует дерево на месте (без выпадающего списка) */}
          <input
            {...noAutofill("cross-level-edge-picker-1")}
            className="ds-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по имени"
            aria-label="Поиск по имени"
            data-autofocus
          />

          {/* Дерево: по умолчанию только прямые дети корня; при поиске — отфильтровано */}
          <div className="clp-tree">
            {allNodes === null ? (
              <p className="clp-note ds-empty">Загрузка</p>
            ) : roots.length === 0 ? (
              <p className="clp-note ds-empty">Нет объектов</p>
            ) : visibleIds && visibleIds.size === 0 ? (
              <p className="clp-note ds-empty">Ничего не найдено</p>
            ) : (
              roots.map((n) => renderNode(n, 0))
            )}
          </div>

          <dl className="ds-props">
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor={`${uid}-label`}>Описание</label></dt>
              <dd className="ds-prop-value">
                <input
                  {...noAutofill("cross-level-edge-picker-2")}
                  id={`${uid}-label`}
                  className="ds-field"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="например, запрос или событие"
                />
              </dd>
            </div>
            <div className="ds-prop">
              <dt className="ds-prop-term"><label htmlFor={`${uid}-tech`}>Технология</label></dt>
              <dd className="ds-prop-value">
                <input
                  {...noAutofill("cross-level-edge-picker-3")}
                  id={`${uid}-tech`}
                  className="ds-field"
                  value={technology}
                  onChange={(e) => setTechnology(e.target.value)}
                  placeholder="например, REST или Kafka"
                />
              </dd>
            </div>
          </dl>
        </div>

        <div className="ds-win-foot">
          {error && <p className="ds-danger ds-win-err">{error}</p>}
          {limit && <p className="ds-danger ds-win-err" role="alert"><LimitText message={limit} /></p>}
          <button type="button" className="ds-btn ds-btn--primary" onClick={submit} disabled={!canCreate}>
            {saving ? "Создаём" : "Создать связь"}
          </button>
          <button type="button" className="ds-btn" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}

// Наконечник соединителя у цели связи: часть линии маршрута, а не значок хрома; сторона
// зависит от направления.
function Head({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      className="clp-conn-head"
      width="7" height="10" viewBox="0 0 7 10" aria-hidden
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round"
    >
      {dir === "right" ? <path d="M1.5 1.5 L5.5 5 L1.5 8.5" /> : <path d="M5.5 1.5 L1.5 5 L5.5 8.5" />}
    </svg>
  );
}
