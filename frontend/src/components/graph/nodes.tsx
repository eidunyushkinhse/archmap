// Кастомные компоненты узлов React Flow и их реестр nodeTypes.
import { useRef, useState, useLayoutEffect, type ComponentType, type CSSProperties } from "react";
import { Handle, type NodeProps, type NodeTypes } from "@xyflow/react";
import {
  SIDE_HANDLES, hid, MAX_TAG_FONT, MIN_TAG_FONT, NODE_W, NODE_H,
  MAX_NAME_FONT, MIN_NAME_FONT, MAX_NAME_LINES, NAME_LINE_HEIGHT,
} from "./constants";
import {
  fixedHandleStyle, NodeShapeSvg, contentPadding,
  nodeContainer, SELECTED_GLOW,
  tagChip, nodeActions, nodeBtn,
} from "./shapes";
import type { BlockRFNode, GhostRFNode, ContainerRFNode, QuickConnectHandlers } from "./types";
import type { EdgeSide } from "./edgePath";
import { canHaveChildren, type NodeStatus } from "../../types";
import { STATUS_META } from "./colors";
import { DrillInIcon, MoreIcon } from "./icons";

// Бейдж статуса в левом-верхнем углу узла (правые углы заняты кнопками действий).
// У existing бейджа нет — кодируем только проектируемое/выводимое. Цвет фона —
// бордер статусной заливки тела (STATUS_FILL.border приходит как c.border).
function StatusBadge({ status, border }: { status: NodeStatus; border: string }) {
  const m = STATUS_META[status];
  if (!m.badge) return null;
  return (
    <span style={{
      // Бейдж страддлит верхнюю кромку узла; опущен ниже (top:-4), чтобы лежать на
      // рамке, но не доставать до первой строки названия. Размер читаемый (fontSize 10).
      position: "absolute", top: -4, left: 10, zIndex: 3,
      fontSize: 10, fontWeight: 700, letterSpacing: ".03em", lineHeight: 1.15,
      padding: "2px 8px", borderRadius: 20, color: "#fff",
      background: border, whiteSpace: "nowrap",
      boxShadow: "0 1px 3px rgba(0,0,0,.18)", pointerEvents: "none",
    }}>{m.badge}</span>
  );
}

// Оверлей «зоны входа»: во время протягивания связи (CSS .lg-canvas--connecting)
// контент узла-контейнера прячется, а по центру показывается «стрелка вниз в лунку» —
// явный сигнал «отпусти здесь, чтобы выбрать узел внутри». pointer-events:none —
// дроп по-прежнему ловит сам узел. Видимостью управляет CSS (.lg-into-cue).
function IntoCue() {
  return (
    <div className="lg-into-cue">
      {/* лунка с глубиной вместо «лотка» */}
      <svg width={46} height={46} viewBox="0 0 24 24" fill="none"
        stroke="#2563eb" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        {/* устье лунки */}
        <ellipse cx="12" cy="17.6" rx="7" ry="3" fill="rgba(37,99,235,.10)" />
        {/* тёмное дно — глубина */}
        <ellipse cx="12" cy="18.3" rx="3.7" ry="1.25" fill="rgba(37,99,235,.32)" stroke="none" />
        {/* стрелка, входящая за край */}
        <path d="M12 3 V13.6" />
        <path d="M8 9.6 L12 14.4 L16 9.6" />
      </svg>
    </div>
  );
}

function NodeHandles({
  nodeId, color, connectableStart = false, quickConnect,
}: { nodeId: string; color: string; connectableStart?: boolean; quickConnect?: QuickConnectHandlers }) {
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
            style={fixedHandleStyle(pos, offset)}
          >
            {/* Видимый круглый дот: рисуется дочерним элементом, чтобы сам хэндл-цель
                оставался тонкой точкой на границе (см. fixedHandleStyle). Он же — зона
                наведения (:hover всплывает на родителя). На измерение хэндла не влияет
                (position:absolute не расширяет getBoundingClientRect родителя). */}
            <span className="lg-handle-dot" style={{ background: color }} />
            {/* Прозрачная зона «быстрой связи» поверх стрелки-подсказки хэндла: навёл
                курсор → система подбирает цель и рисует превью, клик → создаёт связь.
                pointer-events включаются только на ховере хэндла (CSS), чтобы зоны вокруг
                каждого хэндла не перехватывали курсор в покое. stopPropagation на
                pointer/mouse-down — чтобы клик по стрелке не запускал ручное протягивание. */}
            {quickConnect && connectableStart && (
              <button
                type="button"
                className="nodrag lg-quick-arrow"
                aria-label="Создать связь"
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onMouseEnter={() => quickConnect.enter(nodeId, hid(nodeId, side, idx), side as EdgeSide, offset)}
                onMouseLeave={() => quickConnect.leave()}
                onClick={(e) => { e.stopPropagation(); quickConnect.activate(); }}
              />
            )}
          </Handle>
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

// Имя узла: переносится не более чем на MAX_NAME_LINES строки и авто-уменьшает шрифт,
// пока целиком влезает в этот лимит, — иначе длинное имя (напр. «User Management Kafka»
// у брокера с узкой полезной шириной) выдавливало бы чип «роль: технология» вниз за
// край узла. Не влезло даже на минимальном шрифте → обрезаем многоточием (line-clamp),
// полное имя остаётся в title-тултипе. Парная логика к RoleTechChip, но фит по ВЫСОТЕ
// (число строк) И по ширине (длинное слово не должно вылезать за узкую колонку —
// напр. «Пользователь» у person, где аватар съедает левую часть).
function NodeName({ name }: { name: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fontSize, setFontSize] = useState(MAX_NAME_FONT);

  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    // Уменьшаем шрифт, пока имя не уложится в MAX_NAME_LINES строки. При line-clamp
    // scrollHeight отражает ПОЛНУЮ высоту контента (все строки), поэтому сравниваем её
    // с бюджетом «лимит строк × высота строки» текущего шрифта. Плюс ширина: scrollWidth
    // > clientWidth означает, что самое длинное слово не влезает в колонку (слова не
    // рвём — см. wordBreak: normal), поэтому ужимаем шрифт, пока слово не уместится целиком.
    const fit = () => {
      let size = MAX_NAME_FONT;
      el.style.fontSize = `${size}px`;
      const fits = () =>
        el.scrollHeight <= Math.ceil(size * NAME_LINE_HEIGHT * MAX_NAME_LINES) + 1 &&
        el.scrollWidth <= el.clientWidth + 1;
      while (size > MIN_NAME_FONT && !fits()) {
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
  }, [name]);

  return (
    <div
      ref={ref}
      title={name}
      style={{
        fontWeight: 600,
        fontSize,
        lineHeight: NAME_LINE_HEIGHT,
        marginBottom: 4,
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: MAX_NAME_LINES,
        overflow: "hidden",
        // Перенос только между словами; слово целиком не рвём (иначе «Пользовател|ь»).
        // Слишком длинное для колонки слово ужимается шрифтом (фит по ширине выше),
        // а в крайнем случае обрезается overflow — но без распила посреди слова.
        wordBreak: "normal",
        overflowWrap: "normal",
      }}
    >
      {name}
    </div>
  );
}

function BlockNode({ data, selected }: NodeProps<BlockRFNode>) {
  const c = data.colors;
  const shape = data.appNode.shape;
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
        color: c.text,
        // Подсветка выбранного узла: синее свечение по силуэту (drop-shadow
        // тянется по альфе SVG-формы, поэтому ореол повторяет контур любой
        // формы — цилиндра БД, человечка и т.д.). Сигнал «этот узел активен и
        // исчезнет по Backspace».
        filter: selected ? SELECTED_GLOW : undefined,
      }}
    >
      <NodeShapeSvg shape={shape} bg={c.bg} stroke={c.border} />
      <StatusBadge status={data.appNode.status} border={c.border} />
      <NodeHandles nodeId={data.appNode.id} color={c.border} connectableStart={data.connectable} quickConnect={data.quickConnect} />

      {/* Кнопки в правом верхнем углу — абсолютно, не зависят от контента.
          В контекст-режиме (hideActions) их нет — схема только для просмотра. */}
      {intoZone && <IntoCue />}
      {!data.hideActions && (
        <div style={nodeActions}>
          {drillable && (
            <button
              className="nodrag"
              onClick={(e) => { e.stopPropagation(); data.onDrillDown(data.appNode); }}
              style={btnStyle}
              title="Войти"
            ><DrillInIcon /></button>
          )}
          <button
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); data.onEdit(data.appNode); }}
            style={btnStyle}
            title="Подробнее"
          ><MoreIcon /></button>
        </div>
      )}

      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", ...contentPadding(shape, !data.hideActions) }}>
        <NodeName name={data.appNode.name} />
        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <RoleTechChip role={data.appNode.role} technology={data.appNode.technology} color={c.text} />
        </div>
      </div>
    </div>
  );
}

function GhostBlockNode({ data, selected }: NodeProps<GhostRFNode>) {
  const c = data.colors;
  const shape = data.appNode.shape;
  // «Войти» к компонентам гостя — только для промежуточного гостя (есть дети): у
  // атомарного проваливаться некуда. В контекст-режиме onEnter не задаётся → кнопки нет.
  const onEnter = data.onEnter;
  const canEnter = data.appNode.has_children && onEnter != null;
  const btnStyle: CSSProperties = {
    ...nodeBtn,
    background: "rgba(255,255,255,0.18)",
    color: c.text,
    borderColor: "rgba(255,255,255,0.3)",
  };
  // Форма та же, но пунктиром — «призрачность» внешнего узла видна по пунктирному контуру.
  return (
    <div style={{ ...nodeContainer, color: c.text, filter: selected ? SELECTED_GLOW : undefined }}>
      <NodeShapeSvg shape={shape} bg={c.bg} stroke={c.border} dashed />
      <StatusBadge status={data.appNode.status} border={c.border} />
      <NodeHandles nodeId={data.appNode.id} color={c.border} connectableStart={data.connectable} quickConnect={data.quickConnect} />
      {canEnter && (
        <div style={nodeActions}>
          <button
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); onEnter?.(); }}
            style={btnStyle}
            title="Войти к компонентам"
          ><DrillInIcon /></button>
        </div>
      )}
      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", ...contentPadding(shape, canEnter) }}>
        <NodeName name={data.appNode.name} />
        <div style={{ display: "flex", justifyContent: "flex-start" }}>
          <RoleTechChip role={data.appNode.role} technology={data.appNode.technology} color={c.text} />
        </div>
      </div>
    </div>
  );
}

function ContainerNode({ data, selected }: NodeProps<ContainerRFNode>) {
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
    <div data-into="1" style={{ ...nodeContainer, color: c.text, filter: selected ? SELECTED_GLOW : undefined }}>
      <svg width={NODE_W} height={NODE_H} style={{ position: "absolute", inset: 0, pointerEvents: "none", filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.12))" }}>
        <rect x={1} y={1} width={NODE_W - 2} height={NODE_H - 2} rx={8} fill={c.bg} stroke={c.border} strokeWidth={1.5} strokeDasharray="5 3" />
      </svg>
      <NodeHandles nodeId={data.id} color={c.border} connectableStart={data.connectable} quickConnect={data.quickConnect} />
      <div style={nodeActions}>
        {/* «Войти» — навигация на собственный слой контейнера (его компоненты), в
            отличие от лупы, раскрывающей содержимое инлайн на текущем уровне. */}
        {data.onEnter && (
          <button
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); data.onEnter?.(); }}
            style={btnStyle}
            title="Войти к компонентам"
          ><DrillInIcon /></button>
        )}
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
