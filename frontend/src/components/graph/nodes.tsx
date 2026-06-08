// Кастомные компоненты узлов React Flow и их реестр nodeTypes.
import { useRef, useState, useLayoutEffect, type ComponentType, type CSSProperties } from "react";
import { Handle, type NodeProps, type NodeTypes } from "@xyflow/react";
import {
  SIDE_HANDLES, hid, shapeHeight, MAX_TAG_FONT, MIN_TAG_FONT, NODE_W, NODE_H,
} from "./constants";
import {
  fixedHandleStyle, NodeShapeSvg, contentPadding,
  nodeContainer, SELECTED_GLOW,
  tagChip, nodeActions, personActions, nodeBtn,
} from "./shapes";
import type { BlockRFNode, GhostRFNode, ContainerRFNode } from "./types";
import { canHaveChildren } from "../../types";

// Оверлей «зоны входа»: во время протягивания связи (CSS .lg-canvas--connecting)
// контент узла-контейнера прячется, а по центру показывается «стрелка вниз в лунку» —
// явный сигнал «отпусти здесь, чтобы выбрать узел внутри». pointer-events:none —
// дроп по-прежнему ловит сам узел. Видимостью управляет CSS (.lg-into-cue).
function IntoCue() {
  return (
    <div className="lg-into-cue">
      <svg width={46} height={46} viewBox="0 0 24 24" fill="none"
        stroke="#2563eb" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {/* стрелка вниз */}
        <path d="M12 3 V13" />
        <path d="M8 9 L12 13 L16 9" />
        {/* лунка, раскрытая вверх */}
        <path d="M5 15 v2 a2 2 0 0 0 2 2 h10 a2 2 0 0 0 2 -2 v-2" />
      </svg>
    </div>
  );
}

function NodeHandles({
  nodeId, color, connectableStart = false,
}: { nodeId: string; color: string; connectableStart?: boolean }) {
  return (
    <>
      {SIDE_HANDLES.flatMap(({ side, pos, offsets }) =>
        offsets.map((offset, idx) => (
          <Handle
            key={hid(nodeId, side, idx)}
            id={hid(nodeId, side, idx)}
            type="source"
            position={pos}
            // НАЧАТЬ связь с хэндла можно только архитектору (connectableStart) — тогда
            // хэндлы раскрываются по ховеру и тянут новую стрелку. Иначе хэндл инертен
            // (курсор не меняется), но остаётся приёмником конца стрелки при reconnect.
            isConnectableStart={connectableStart}
            style={fixedHandleStyle(pos, offset, color)}
          />
        ))
      )}
    </>
  );
}

// Единое «облако» с ролью и технологией: «{роль}: {технология}» (если есть оба,
// иначе — то, что задано). Выравнивание задаёт родитель. Шрифт авто-уменьшается,
// чтобы строка влезла в доступную ширину узла (важно для узлов разного размера).
function RoleTechChip({
  role, technology, color,
}: { role?: string | null; technology?: string | null; color: string }) {
  const label = role && technology ? `${role}: ${technology}` : role || technology || "";
  const ref = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(MAX_TAG_FONT);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    // Уменьшаем шрифт от MAX до MIN, пока чип не впишется в ширину родителя
    const fit = () => {
      let size = MAX_TAG_FONT;
      el.style.fontSize = `${size}px`;
      while (size > MIN_TAG_FONT && el.scrollWidth > parent.clientWidth) {
        size -= 0.5;
        el.style.fontSize = `${size}px`;
      }
      setFontSize(size);
    };
    fit();
    // Пересчёт при изменении ширины узла (узлы разного размера / ресайз)
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [label]);

  if (!label) return null;
  return (
    <span
      ref={ref}
      style={{
        ...tagChip,
        marginRight: 0,
        maxWidth: "100%",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        background: "rgba(255,255,255,0.22)",
        color,
        fontSize,
      }}
    >
      {label}
    </span>
  );
}

function BlockNode({ data, selected }: NodeProps<BlockRFNode>) {
  const c = data.colors;
  const shape = data.appNode.shape;
  // У пользователя «провалиться внутрь» нечего → кнопку «Войти» не показываем.
  // Голова человечка — узкий круг по центру вверху, поэтому стандартное место
  // кнопок (правый верхний угол) висит в пустоте сбоку от головы: для персоны
  // опускаем действия внутрь прямоугольника-тела (personActions).
  const isPerson = shape === "person";
  // «Провалиться внутрь»/быть зоной входа может только сервис (см. canHaveChildren):
  // у БД/брокера/пользователя детей нет — кнопку «Войти» им не показываем.
  const drillable = canHaveChildren(shape);
  const intoZone = drillable && data.appNode.has_children;
  const btnStyle: CSSProperties = {
    ...nodeBtn,
    background: "rgba(255,255,255,0.18)",
    color: c.text,
    borderColor: "rgba(255,255,255,0.3)",
  };
  return (
    <div
      // data-into помечает узел как «зону входа»: связь, протянутую на узел-сервис
      // С ДЕТЬМИ, нельзя замкнуть на него самого (это алерт-кейс) — отпускание
      // открывает выбор его потомка. Визуал зоны во время протягивания — по CSS
      // этого атрибута. У БД/брокера детей нет (canHaveChildren), они не зоны входа.
      data-into={intoZone ? "1" : undefined}
      style={{
        ...nodeContainer,
        height: shapeHeight(shape),
        color: c.text,
        // Подсветка выбранного узла: синее свечение по силуэту (drop-shadow
        // тянется по альфе SVG-формы, поэтому ореол повторяет контур любой
        // формы — цилиндра БД, человечка и т.д.). Сигнал «этот узел активен и
        // исчезнет по Backspace».
        filter: selected ? SELECTED_GLOW : undefined,
      }}
    >
      <NodeShapeSvg shape={shape} bg={c.bg} stroke={c.border} />
      <NodeHandles nodeId={data.appNode.id} color={c.border} connectableStart={data.connectable} />

      {/* Кнопки в правом верхнем углу — абсолютно, не зависят от контента.
          В контекст-режиме (hideActions) их нет — схема только для просмотра. */}
      {intoZone && <IntoCue />}
      {!data.hideActions && (
        <div style={isPerson ? personActions : nodeActions}>
          {drillable && (
            <button
              className="nodrag"
              onClick={(e) => { e.stopPropagation(); data.onDrillDown(data.appNode); }}
              style={btnStyle}
              title="Войти"
            >→</button>
          )}
          <button
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); data.onEdit(data.appNode); }}
            style={btnStyle}
            title={data.isArchitect ? "Изменить" : "Просмотр"}
          >{data.isArchitect ? "✎" : "◉"}</button>
        </div>
      )}

      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", ...contentPadding(shape, !data.hideActions) }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>
          {data.appNode.name}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <RoleTechChip role={data.appNode.role} technology={data.appNode.technology} color={c.text} />
        </div>
      </div>
    </div>
  );
}

function GhostBlockNode({ data }: NodeProps<GhostRFNode>) {
  const c = data.colors;
  const shape = data.appNode.shape;
  // Форма та же, но пунктиром — «призрачность» внешнего узла видна по пунктирному контуру.
  return (
    <div style={{ ...nodeContainer, height: shapeHeight(shape), color: c.text }}>
      <NodeShapeSvg shape={shape} bg={c.bg} stroke={c.border} dashed />
      <NodeHandles nodeId={data.appNode.id} color={c.border} connectableStart={data.connectable} />
      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", ...contentPadding(shape, false) }}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{data.appNode.name}</div>
        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <RoleTechChip role={data.appNode.role} technology={data.appNode.technology} color={c.text} />
        </div>
      </div>
    </div>
  );
}

function ContainerNode({ data }: NodeProps<ContainerRFNode>) {
  const c = data.colors;
  const btnStyle: CSSProperties = {
    ...nodeBtn,
    background: "rgba(255,255,255,0.18)",
    color: c.text,
    borderColor: "rgba(255,255,255,0.3)",
  };
  return (
    // Свёрнутый контейнер — всегда «зона входа»: его содержимое детализируется,
    // протянутая на него стрелка ведёт к одному из его потомков (data-into).
    <div data-into="1" style={{ ...nodeContainer, color: c.text }}>
      <svg width={NODE_W} height={NODE_H} style={{ position: "absolute", inset: 0, pointerEvents: "none", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.12))" }}>
        <rect x={1} y={1} width={NODE_W - 2} height={NODE_H - 2} rx={8} fill={c.bg} stroke={c.border} strokeWidth={1.5} strokeDasharray="5 3" />
      </svg>
      <NodeHandles nodeId={data.id} color={c.border} connectableStart={data.connectable} />
      <div style={nodeActions}>
        <button
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); data.onExpand(data.id); }}
          style={btnStyle}
          title="Раскрыть содержимое"
        >🔍</button>
      </div>
      <IntoCue />
      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", padding: "12px 14px", paddingRight: 40 }}>
        <div style={{ fontSize: 10, opacity: 0.8, fontWeight: 500, marginBottom: 2 }}>контейнер</div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{data.name}</div>
      </div>
    </div>
  );
}

// Невидимый узел-распорка (контекст-схема): ставится в крайние точки контента, включая
// обходы не родных стрелок, чтобы fitView (фитит только узлы) вмещал весь рисунок.
function SpacerNode() {
  return <div style={{ width: 1, height: 1, pointerEvents: "none" }} />;
}

export const nodeTypes: NodeTypes = {
  block: BlockNode as ComponentType<NodeProps>,
  ghost: GhostBlockNode as ComponentType<NodeProps>,
  container: ContainerNode as ComponentType<NodeProps>,
  spacer: SpacerNode as ComponentType<NodeProps>,
};
