// Живая схема для лендинга: настоящий холст (LevelGraph) на снимке демо-проекта.
// Поведение — как у встроенной схемы на страницах (EmbeddedSchemaBlock): холст инертен
// до клика, чтобы колесо и свайп листали лендинг, а не схему; Esc, «Готово» и уход
// фокуса из окна (клик по лендингу вокруг iframe) возвращают его в покой. Отличия от
// страничного блока: тулбара нет, блок занимает всё окно iframe, расстановка и раскрытия
// живут в памяти вкладки (staticBackend), двойной клик по узлу никуда не ведёт.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent } from "react";
import LevelGraph from "../components/LevelGraph";
import { toLevelEdges } from "../components/pageSchema";
import { useEdgeChoice } from "../components/graph/interaction/useEdgeChoice";
import type {
  LevelDrillCallbacks, LevelEdgeCallbacks, LevelModeFlags, LevelPersistenceProps,
} from "../components/graph/types";
import type { LevelEdge, ViewLayout, ViewLayoutPayload } from "../types";
import type { LandingScene } from "./scene";
import "../components/EmbeddedSchemaBlock.css";

// Лупа свёрнутого контейнера (graph/nodes.tsx): на ней пульс-подсказка до первого раскрытия.
const LENS = 'button[title="Раскрыть содержимое"]';

const noop = () => {};

// Пульс на лупе фокуса — как в прототипе лендинга. Селектор с id узла, поэтому правило
// собирается здесь; при reduced motion вместо пульса — неподвижное кольцо.
function lensHintCss(nodeId: string): string {
  const sel = `.lp-wrap .react-flow__node[data-id="${nodeId}"] ${LENS}`;
  return `${sel}{animation:lp-pulse 1.8s ease-out infinite}`
    + `@media (prefers-reduced-motion: reduce){${sel}{animation:none;box-shadow:0 0 0 3px rgba(255,255,255,.75)}}`;
}

export default function LandingSchema({ scene }: { scene: LandingScene }) {
  const { graph } = scene;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  // Подсказка на лупе держится, пока посетитель ни разу не раскрыл контейнер
  const [hinted, setHinted] = useState(true);
  // Зеркало раскладки вида: сюда холст пишет перетаскивания и раскрытия (onLayoutChanged)
  const [layout, setLayout] = useState<ViewLayout>(graph.layout);

  const edges = useMemo(() => toLevelEdges(graph), [graph]);
  const ancestorNames = useMemo(() => scene.ancestors.map((a) => a.name), [scene]);
  const ancestorIds = useMemo(() => scene.ancestors.map((a) => a.id), [scene]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(false);
    };
    const onBlur = () => setActive(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [active]);

  // Первый клик и включает холст, и доходит до кнопки под курсором (лупа, «Свернуть»):
  // иначе раскрытие контейнера стоило бы посетителю двух кликов.
  const activate = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    const { clientX, clientY } = e;
    setActive(true);
    requestAnimationFrame(() => {
      const target = document.elementFromPoint(clientX, clientY)?.closest("button");
      if (target && wrapRef.current?.contains(target)) target.click();
    });
  }, []);

  // merge поверх зеркала; null-патч — удалить строку (как handleLayoutChanged страницы объекта)
  const onLayoutChanged = useCallback((items: Record<string, ViewLayoutPayload | null>) => {
    setLayout((cur) => Object.fromEntries(
      Object.entries({ ...cur, ...items })
        .filter((e): e is [string, ViewLayoutPayload] => e[1] !== null),
    ));
  }, []);
  const persistence = useMemo<LevelPersistenceProps>(() => ({ onLayoutChanged }), [onLayoutChanged]);

  // Структура read-only, расстановка включена (arrangeOnly: драг, undo, запись в зеркало).
  // Раскрытий в снимке нет, поэтому схема стартует свёрнутой и без ignorePersistedExpanded.
  const mode = useMemo<LevelModeFlags>(() => ({
    readOnly: true,
    arrangeOnly: true,
    fitOnLoad: true,
    fitOnExpand: true,
    edgesInspectable: true,
    schemaView: "all",
  }), []);

  // Двойной клик по стрелке — подсветка полного пути, по общему плечу — окно выбора связи.
  const [selectedEdge, setSelectedEdge] = useState<LevelEdge | null>(null);
  const resolveEdge = useCallback((id: string) => edges.find((e) => e.id === id) ?? null, [edges]);
  const labelOf = useCallback(
    (id: string): string =>
      graph.nodes.find((n) => n.id === id)?.name ?? graph.endpoints.find((ep) => ep.id === id)?.name ?? id,
    [graph],
  );
  const linkedHighlight = useMemo(
    (): { kind: "node" | "edge"; id: string } | null =>
      selectedEdge ? { kind: "edge", id: selectedEdge.id } : null,
    [selectedEdge],
  );
  const { onEdgesChoice, onTrunkChoice, choiceModal } = useEdgeChoice({
    resolveEdge, labelOf, onPick: setSelectedEdge,
  });
  const edgeCallbacks = useMemo<LevelEdgeCallbacks>(() => ({
    onEdgesChoice,
    onTrunkChoice,
  }), [onEdgesChoice, onTrunkChoice]);
  const drill = useMemo<LevelDrillCallbacks>(() => ({
    onDrillDown: noop,
    onEditNode: noop,
    onClearSelection: () => setSelectedEdge(null),
  }), []);

  return (
    <div
      ref={wrapRef}
      className={"esb-wrap lp-wrap" + (active ? " esb-wrap--active" : "")}
      onClickCapture={(e) => {
        if ((e.target as Element).closest(LENS)) setHinted(false);
      }}
    >
      {hinted && scene.layoutViewId && <style>{lensHintCss(scene.layoutViewId)}</style>}
      {!active && (
        <button type="button" className="esb-activate lp-activate" onClick={activate}>
          <span className="esb-activate-pill lp-pill">
            <span className="lp-pill-long">Нажмите, чтобы двигать объекты и раскрывать контейнеры</span>
            <span className="lp-pill-short">Попробовать</span>
          </span>
        </button>
      )}
      <div className="esb-canvas">
        <LevelGraph
          nodes={graph.nodes}
          endpoints={graph.endpoints}
          edges={edges}
          viewLayout={layout}
          containerId={scene.containerId}
          layoutViewId={scene.layoutViewId}
          persistence={persistence}
          ancestorNames={ancestorNames}
          ancestorIds={ancestorIds}
          depth={scene.ancestors.length}
          isArchitect
          linkedHighlight={linkedHighlight}
          mode={mode}
          drill={drill}
          edgeCallbacks={edgeCallbacks}
        />
      </div>
      {active && (
        <button type="button" className="lp-done" onClick={() => setActive(false)}>Готово</button>
      )}
      {choiceModal}
    </div>
  );
}
