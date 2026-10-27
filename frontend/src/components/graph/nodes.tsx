// Кастомные компоненты узлов React Flow и их реестр nodeTypes.
import { useRef, useState, useLayoutEffect, type ComponentType, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
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
import type { BlockRFNode, GhostRFNode, ContainerRFNode, FrameRFNode, FrameDockRFNode, SiteRFNode, QuickConnectHandlers } from "./types";
import type { EdgeSide } from "./edgePath";
import { canHaveChildren, type NodeStatus } from "../../types";
import { STATUS_META } from "./colors";
import { DrillInIcon } from "./icons";
import FramePlaque from "./FramePlaque";
import { SiteKindIcon } from "../../ui/icons";
import { useToast } from "../../pages/useToast";

// Кэш подобранных размеров шрифта (оптимизация 2026-07-21): одинаковые имена/роли
// при одинаковой ширине узла не пересчитываются. Ключ: `${text}|${width}`.
// Для 80 узлов с повторяющимися ролями («сервис», «БД») экономия существенна.
const fontSizeCache = new Map<string, number>();

// Бейдж статуса в левом-верхнем углу узла (правые углы заняты кнопками действий).
// У existing бейджа нет — кодируем только проектируемое/выводимое. Цвет фона —
// бордер статусной заливки тела (STATUS_FILL.border приходит как c.border).
function StatusBadge({ status, border }: { status: NodeStatus; border: string }) {
  const m = STATUS_META[status];
  if (!m.badge) return null;
  return (
    <span style={{
      // Бейдж страддлит верхнюю кромку узла так, что его ЦЕНТР лежит ровно на рамке
      // (фиксированная height + top = -height/2). Текст центрируется по вертикали
      // флексом (inline-flex + alignItems center), иначе lineHeight тянул его вниз.
      position: "absolute", top: -8, left: 10, zIndex: 3, height: 16,
      display: "inline-flex", alignItems: "center",
      fontSize: 10, fontWeight: 700, letterSpacing: ".03em", lineHeight: 1,
      padding: "0 8px", borderRadius: 20, color: "#fff",
      background: border, whiteSpace: "nowrap",
      boxShadow: "0 1px 3px rgba(0,0,0,.18)", pointerEvents: "none",
    }}>{m.badge}</span>
  );
}

// Бейдж «есть дети»: глиф-дерево (узел-родитель сверху, ветви к детям вниз) + число
// прямых детей. Показывается у узлов с под-схемой — сигнал «сюда можно войти», читаемый
// без вглядывания в кнопки. Цвет наследует text-цвет узла. child_count считает бэкенд.
// На read-only странице count — РЕЛЕВАНТНЫЕ дети (X16 v2), total — все дети по БД:
// при расхождении бейдж показывает «N из M» (сколько на схеме из скольких всего).
function ChildrenBadge({ count, total, color }: { count: number; total?: number; color: string }) {
  return (
    <span style={{
      position: "absolute", right: 12, bottom: 12, zIndex: 1,
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 11, fontWeight: 700, lineHeight: 1,
      color, opacity: 0.95, pointerEvents: "none",
    }}>
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
        style={{ display: "block" }} aria-hidden>
        <circle cx="12" cy="6" r="2.3" />
        <circle cx="6" cy="18" r="2.3" />
        <circle cx="18" cy="18" r="2.3" />
        <path d="M12 8.3 V13" />
        <path d="M6 15.7 V13 H18 V15.7" />
      </svg>
      {total !== undefined && total > count ? `${count} из ${total}` : count}
    </span>
  );
}

// Пометка карточки от хозяина проекции (BlockData.mark): на холсте развёртывания —
// «1/2», экземпляр 1 из 2 (объект стоит на нескольких площадках, deployment.md). Место
// и вид — как у бейджа детей (правый-нижний угол, цвет текста узла); глиф — две
// стопкой лежащие карточки. У экземпляра детей нет, поэтому бейджи не встречаются.
function MarkBadge({ text, color }: { text: string; color: string }) {
  return (
    <span className="lg-node-mark" style={{
      position: "absolute", right: 12, bottom: 12, zIndex: 1,
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 11, fontWeight: 700, lineHeight: 1,
      color, opacity: 0.95, pointerEvents: "none",
    }}>
      <svg width={13} height={13} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"
        style={{ display: "block" }} aria-hidden>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8 V6 a2 2 0 0 0-2-2 H6 a2 2 0 0 0-2 2 v8 a2 2 0 0 0 2 2 h2" />
      </svg>
      {text}
    </span>
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

// Хэндлы узла (Ф5 эпика «стрелки без жёстких хэндлов»): по одному на сторону, в её
// центре. Сам хэндл невидим (2-px точка на границе, fixedHandleStyle) — он служебная
// точка React Flow: id стороны, которым роутер отдаёт ребро для отрисовки, и старт
// превью-линии протяжки. Точек стыковки на узле нет: концы связей стоят на портах
// роутера (edge.md E7 v2), и сторона, откуда тянули, на порт не влияет.
// Видимое приглашение — стрелка-глиф .lg-side-arrow снаружи стороны (CSS: появляется
// на ховере узла у архитектора). Глиф — одна зона для двух жестов (E72/E75):
//   • клик — быстрая связь: навёл → превью к соседу в этом направлении, клик → связь;
//   • протяжка — mousedown всплывает к хэндлу RF, и он ведёт connection-жест; порог
//     connectionDragThreshold отличает клик от начала протяжки.
function NodeHandles({
  nodeId, connectableStart = false, quickConnect,
}: { nodeId: string; connectableStart?: boolean; quickConnect?: QuickConnectHandlers }) {
  return (
    <>
      {SIDE_HANDLES.map(({ side, pos }) => {
        const id = hid(nodeId, side);
        return (
          <Handle
            key={id}
            id={id}
            type="source"
            position={pos}
            // НАЧАТЬ связь можно только архитектору (connectableStart) — тогда у хэндла
            // есть глиф и он тянет новую стрелку. Иначе хэндл инертен, но остаётся
            // приёмником конца стрелки (защёлка радиуса connectionRadius).
            isConnectableStart={connectableStart}
            style={fixedHandleStyle(pos, 0.5)}
          >
            {quickConnect && connectableStart && (
              <button
                type="button"
                className="nodrag lg-side-arrow"
                aria-label="Создать связь"
                onMouseEnter={() => quickConnect.enter(nodeId, side as EdgeSide, 0.5)}
                onMouseLeave={() => quickConnect.leave()}
                // stopPropagation: клик по глифу — быстрая связь, а не click-connect RF
                // (он и так выключен: connectOnClick={false} в LevelGraph)
                onClick={(e) => { e.stopPropagation(); quickConnect.activate(); }}
              />
            )}
          </Handle>
        );
      })}
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
    // Уменьшаем шрифт от MAX до MIN, пока чип не впишется в ширину родителя.
    // Кэш по (текст, ширина): одинаковые роли при одинаковой ширине не пересчитываются.
    const fit = () => {
      const width = parent.clientWidth;
      const cacheKey = `${label}|${width}`;
      const cached = fontSizeCache.get(cacheKey);
      if (cached !== undefined) {
        el.style.fontSize = `${cached}px`;
        setFontSize(cached);
        return;
      }
      let size = MAX_TAG_FONT;
      el.style.fontSize = `${size}px`;
      while (size > MIN_TAG_FONT && el.scrollWidth > width) {
        size -= 0.5;
        el.style.fontSize = `${size}px`;
      }
      fontSizeCache.set(cacheKey, size);
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
    // Кэш по (текст, ширина): одинаковые имена при одинаковой ширине не пересчитываются.
    const fit = () => {
      const width = parent.clientWidth;
      const cacheKey = `${name}|${width}`;
      const cached = fontSizeCache.get(cacheKey);
      if (cached !== undefined) {
        el.style.fontSize = `${cached}px`;
        setFontSize(cached);
        return;
      }
      let size = MAX_NAME_FONT;
      el.style.fontSize = `${size}px`;
      const fits = () =>
        el.scrollHeight <= Math.ceil(size * NAME_LINE_HEIGHT * MAX_NAME_LINES) + 1 &&
        el.scrollWidth <= el.clientWidth + 1;
      while (size > MIN_NAME_FONT && !fits()) {
        size -= 0.5;
        el.style.fontSize = `${size}px`;
      }
      fontSizeCache.set(cacheKey, size);
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

// Текст неактивной лупы (C8). Кнопка на предельной глубине остаётся видимой, но не
// раскрывает: исчезающая кнопка не объясняет себя, а подсказка называет и предел, и
// выход из него.
const LENS_LIMIT_HINT =
  "Контейнеры можно раскрыть только два раза подряд. Чтобы посмотреть состав этого контейнера, спуститесь на слой ниже";

// Лупа «Раскрыть содержимое» — общая для локального блока, гостевого контейнера и
// карточки свёрнутой площадки (у неё своя подсказка, title).
// Ровно одно из двух: активная (onExpand) или неактивная на пределе глубины (limited).
function ExpandLens({ onExpand, limited, style, title = "Раскрыть содержимое" }: {
  onExpand?: () => void;
  limited?: boolean;
  style: CSSProperties;
  title?: string;
}) {
  const [hint, showHint] = useToast(6000);
  if (!onExpand && !limited) return null;
  return (
    <>
      <button
        className="nodrag"
        data-tour="node-expand"
        onClick={(e) => { e.stopPropagation(); if (limited) showHint(); else onExpand?.(); }}
        style={limited ? { ...style, opacity: 0.45, cursor: "help" } : style}
        title={limited ? LENS_LIMIT_HINT : title}
        aria-disabled={limited || undefined}
      >🔍</button>
      {hint && (
        // Подсказка висит под рядом кнопок (nodeActions — ближайший позиционированный
        // предок) и шире узла: выходит за его левый край, зато читается в две строки.
        // Сама гаснет по таймеру; клик по ней не проваливается в узел (выделение).
        <div
          className="nodrag"
          onClick={(e) => { e.stopPropagation(); }}
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 5,
            width: 236, padding: "7px 9px", borderRadius: 6,
            background: "rgba(17,24,39,0.94)", color: "#f9fafb",
            fontSize: 11, lineHeight: 1.35, fontWeight: 500, textAlign: "left",
            boxShadow: "0 4px 12px rgba(0,0,0,0.28)", cursor: "default",
          }}
        >{LENS_LIMIT_HINT}</div>
      )}
    </>
  );
}

// Режим выбора площадки (onPick): обёртка RF без выделения и драга прозрачна для мыши
// (pointer-events: none), поэтому щелчок принимает сам узел.
const PICK_STYLE: CSSProperties = { pointerEvents: "auto", cursor: "crosshair" };

// Перехват щелчка в режиме выбора площадки (onPick у рамки и карточек, развёртывание):
// фаза перехвата на корне узла — щелчок по любой его части (плашке, крестику, лупе)
// выбирает, а не делает своё; дальше событие не идёт.
function pickCapture(id: string, onPick: ((id: string) => void) | undefined) {
  if (!onPick) return undefined;
  return (e: ReactMouseEvent) => { e.stopPropagation(); e.preventDefault(); onPick(id); };
}

function BlockNode({ id, data, selected }: NodeProps<BlockRFNode>) {
  const c = data.colors;
  const shape = data.appNode.shape;
  // «Провалиться внутрь»/быть зоной входа может только сервис (см. canHaveChildren):
  // у БД/брокера/пользователя детей нет — кнопку «Войти» им не показываем.
  const drillable = canHaveChildren(shape);
  // Дети для бейджа/зоны входа: read-only (страница) — релевантные (badgeCount),
  // редактор — все (badgeCount == child_count по построению assembleRf).
  const childCount = data.badgeCount;
  const intoZone = drillable && childCount > 0;
  // Кнопки действий: «Войти» (onDrillDown) — только в редакторе, лупа (onExpand) —
  // и на странице объекта (инлайн-раскрытие — просмотрная механика).
  const hasActions = !data.hideActions && drillable
    && !!(data.onDrillDown || data.onExpand || data.expandLimited);
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
        // Режим выбора площадки: обёртка RF без выделения и драга прозрачна для мыши —
        // щелчок ловит сама карточка (выбор её площадки).
        ...(data.onPick ? PICK_STYLE : null),
      }}
      onClickCapture={pickCapture(id, data.onPick)}
    >
      {/* Пунктир — цельный контейнер развёртывания (проекция его не раскрывает). */}
      <NodeShapeSvg shape={shape} bg={c.bg} stroke={c.border} dashed={data.dashed} />
      <StatusBadge status={data.appNode.status} border={c.border} />
      <NodeHandles nodeId={data.appNode.id} connectableStart={data.connectable} quickConnect={data.quickConnect} />

      {/* Кнопки в правом верхнем углу — абсолютно, не зависят от контента. */}
      {intoZone && <IntoCue />}
      {/* Бейдж «есть дети» — в правом-нижнем углу узла с под-схемой. */}
      {intoZone && <ChildrenBadge count={childCount} total={data.appNode.child_count} color={c.text} />}
      {/* Пометка хозяина проекции («1/2» на холсте развёртывания) — тот же угол. */}
      {data.mark && <MarkBadge text={data.mark} color={c.text} />}
      {/* Мета узла открывается двойным кликом по нему (правая панель), отдельной
          кнопки «Подробнее» больше нет — «Войти» у сервисов (только редактор) и
          лупа «Раскрыть содержимое» (R5, инлайн-раскрытие; и редактор, и страница). */}
      {hasActions && (
        <div style={nodeActions}>
          {data.onDrillDown && (
            <button
              className="nodrag"
              data-tour="node-enter"
              onClick={(e) => { e.stopPropagation(); data.onDrillDown?.(data.appNode); }}
              style={btnStyle}
              title="Войти"
            ><DrillInIcon /></button>
          )}
          <ExpandLens
            onExpand={data.onExpand ? () => data.onExpand?.(data.appNode.id) : undefined}
            limited={data.expandLimited}
            style={btnStyle}
          />
        </div>
      )}

      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", ...contentPadding(shape, hasActions) }}>
        <NodeName name={data.appNode.name} />
        <div style={{ display: "flex", justifyContent: "flex-start", paddingRight: intoZone || data.mark ? 34 : 0 }}>
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
  // атомарного проваливаться некуда. На странице объекта (read-only) onEnter не
  // задаётся → кнопки нет.
  const onEnter = data.onEnter;
  const hasChildren = data.appNode.has_children;
  const canEnter = hasChildren && onEnter != null;
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
      <NodeHandles nodeId={data.appNode.id} connectableStart={data.connectable} quickConnect={data.quickConnect} />
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
      {/* Бейдж «есть дети» — у промежуточного гостя (есть под-схема), без привязки к onEnter. */}
      {hasChildren && <ChildrenBadge count={data.appNode.child_count} color={c.text} />}
      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", ...contentPadding(shape, canEnter) }}>
        <NodeName name={data.appNode.name} />
        <div style={{ display: "flex", justifyContent: "flex-start", paddingRight: hasChildren ? 34 : 0 }}>
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
      <NodeHandles nodeId={data.id} connectableStart={data.connectable} quickConnect={data.quickConnect} />
      {(data.onEnter || data.onExpand || data.expandLimited) && (
        <div style={nodeActions}>
          {/* «Войти» — навигация на собственный слой контейнера (его компоненты), в
              отличие от лупы, раскрывающей содержимое инлайн на текущем уровне.
              Только редактор: на странице объекта onEnter не задаётся. */}
          {data.onEnter && (
            <button
              className="nodrag"
              onClick={(e) => { e.stopPropagation(); data.onEnter?.(); }}
              style={btnStyle}
              title="Войти к компонентам"
            ><DrillInIcon /></button>
          )}
          {/* Лупа активна, пока контейнер не на пределе инлайн-глубины (C8): глубже
              MAX_INLINE_DEPTH onExpand не задаётся, кнопка остаётся неактивной. */}
          <ExpandLens
            onExpand={data.onExpand ? () => data.onExpand?.(data.id) : undefined}
            limited={data.expandLimited}
            style={btnStyle}
          />
        </div>
      )}
      <IntoCue />
      <div style={{ position: "relative", zIndex: 1, height: "100%", boxSizing: "border-box", overflow: "hidden", padding: "12px 14px", paddingRight: 40 }}>
        <div style={{ fontSize: 10, opacity: 0.8, fontWeight: 500, marginBottom: 2 }}>контейнер</div>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{data.name}</div>
      </div>
    </div>
  );
}

// РАСКРЫТАЯ гостевая рамка — настоящий RF-узел (R4, compound). Реальный rect: позицию
// и размер задаёт раскладка (width/height на самом узле), дети сидят внутри через
// parentId в координатах рамки. Визуально — прежний lg-frame (пунктир + подпись
// слева-внизу); класс и data-frame-id сохранены как стабильный хук полигона. Плашка
// подписи рисуется НЕ внутри рамки, а в слое плашек подписей (FramePlaque, CV33): рамка
// лежит под линиями стрелок, а плашка обязана быть над ними — линия проходит под ней.
// ИНТЕРЬЕР рамки прозрачен для мыши (pointerEvents:none) — клики/драг проходят к
// канве, узлам и рёбрам под ней. Рамка НЕ таскается (запрет движения рамок,
// 2026-07-08): её rect производен от детей; прежние драг-ручки R4.2 сняты.
// Хэндлы на границе рамки (эпик «связи, упирающиеся в рамку»): связь, чей конец —
// раскрытый контейнер, приходит НА РАМКУ, и RF обязан знать хэндл с этим id — иначе
// ребро молча не отрисуется. По одному на сторону, инертны: ни глифа, ни быстрой связи,
// начать связь с рамки нельзя; перевес её конца ведёт ручка на самом ребре
// (RehangAnchor), а не хэндл.
function FrameHandles({ nodeId }: { nodeId: string }) {
  return (
    <>
      {SIDE_HANDLES.map(({ side, pos }) => (
        <Handle
          key={hid(nodeId, side)}
          id={hid(nodeId, side)}
          type="source"
          position={pos}
          isConnectableStart={false}
          style={{ ...fixedHandleStyle(pos, 0.5), pointerEvents: "none" }}
        />
      ))}
    </>
  );
}

// Декор по данным (FrameData.decor, холст развёртывания, deployment.md): ПЛОЩАДКА — зона:
// лёгкая заливка и тонкая светлая граница (та же адаптация к зуму через --lg-frame-bw)
// вместо линии, которая сливалась со стрелками; вложенная зона рисуется поверх и
// выходит темнее сама. На плашке иконка вида вместо лупы, клик по плашке и крестик
// сворачивают площадку в карточку (SiteCardNode). ГРУППА («Размещение не указано») —
// пунктир как у раскрытия, плашка без иконки и крестика.
function FrameNode({ id, data, positionAbsoluteX, positionAbsoluteY, height }: NodeProps<FrameRFNode>) {
  const decor = data.decor;
  const site = decor?.kind === "site";
  const collapseTitle = site ? "Свернуть площадку" : "Свернуть";
  // Режим выбора площадки: тело рамки ловит щелчок (обычно прозрачно для мыши), плашка
  // не сворачивает, а тоже выбирает (перехват на корне). Курсор и подсветка — CSS
  // lg-frame--pick.
  const picking = !!data.onPick;
  return (
    <div
      className={"lg-frame" + (decor ? ` lg-frame--${decor.kind}` : "") + (picking ? " lg-frame--pick" : "")}
      data-frame-id={id}
      onClickCapture={pickCapture(id, data.onPick)}
      style={{
        width: "100%", height: "100%",
        // толщина из --lg-frame-bw (холст, LevelGraph): 1px при обычном зуме, растёт
        // при отдалении — на экране рамка всегда ~1px и не исчезает
        border: site
          ? "var(--lg-frame-bw, 1px) solid #cbd5e1"
          : "var(--lg-frame-bw, 1px) dashed #9ca3af",
        borderRadius: 12, background: site ? "rgba(100,116,139,0.07)" : "transparent",
        boxSizing: "border-box", pointerEvents: picking ? "auto" : "none",
      }}
    >
      <FrameHandles nodeId={id} />
      {/* Плашка подписи: клик по ВСЕЙ плашке сворачивает (крупная цель; раньше был
          только маленький ✕, а плашка занята драгом — драг рамок запрещён, цель
          вернулась клику). Портал в слой плашек: позиция — абсолютная, левый-нижний
          угол рамки (в режиме выбора площадки щелчок перехватывает корень — портал
          для React-событий прозрачен). */}
      <FramePlaque
        frameId={id}
        x={positionAbsoluteX}
        bottom={positionAbsoluteY + (height ?? 0)}
        interactive
        onClick={data.onCollapse}
        title={data.onCollapse ? collapseTitle : undefined}
      >
        {decor ? (
          <>
            {site && <SiteKindIcon kind={decor.icon ?? "other"} size={14} />}
            <span>{data.name}</span>
          </>
        ) : (
          <span>🔍 {data.name}</span>
        )}
        {data.onCollapse && (
          <button
            className="nodrag"
            onClick={(e) => { e.stopPropagation(); data.onCollapse?.(); }}
            title={collapseTitle}
            style={{
              border: "none", background: "transparent", cursor: "pointer",
              padding: 0, fontSize: 12, lineHeight: 1, color: "#64748b", fontWeight: 700,
            }}
          >✕</button>
        )}
      </FramePlaque>
    </div>
  );
}

// Карточка площадки (холст развёртывания, deployment.md): свёрнутая или пустая на уровне
// площадка. Белая, а не синяя, — площадка не объект: иконка вида, имя «Имя ·
// технология», серым число объектов на ней на этом уровне, лупа «Раскрыть площадку» у
// свёрнутой (двойной клик — то же, LevelGraph). Размер — блока (NODE_W × NODE_H): на
// него рассчитаны раскладка и замер узлов. Хэндлы как у блока — связи свёрнутой
// площадки упираются в карточку; начать связь с неё нельзя (холст только для чтения).
const SITE_LENS_STYLE: CSSProperties = {
  ...nodeBtn, background: "#f8fafc", color: "#64748b", borderColor: "#e2e8f0",
};

function SiteCardNode({ id, data, selected }: NodeProps<SiteRFNode>) {
  return (
    <div
      className={"lg-site-card" + (data.onPick ? " lg-site-card--pick" : "")}
      title={data.onExpand ? undefined : "Площадка пуста на этом уровне"}
      style={{
        ...nodeContainer,
        display: "flex", alignItems: "center", gap: 10, padding: "0 10px 0 14px",
        background: "#fff", border: "1px solid #94a3b8", borderRadius: 8, color: "#475569",
        boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
        filter: selected ? SELECTED_GLOW : undefined,
        // режим выбора площадки: щелчок по карточке (и по лупе) — выбор, не раскрытие
        ...(data.onPick ? PICK_STYLE : null),
      }}
      onClickCapture={pickCapture(id, data.onPick)}
    >
      <NodeHandles nodeId={id} />
      <span style={{ display: "inline-flex", flex: "none", color: "#64748b" }}>
        <SiteKindIcon kind={data.icon} size={20} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <NodeName name={data.name} />
      </div>
      {data.count > 0 && (
        <span
          className="lg-site-count"
          title={`Объектов на площадке: ${data.count}`}
          style={{ flex: "none", fontSize: 12, fontWeight: 600, color: "#94a3b8" }}
        >{data.count}</span>
      )}
      {data.onExpand && (
        <span style={{ flex: "none", position: "relative" }}>
          <ExpandLens
            onExpand={() => data.onExpand?.(id)}
            title="Раскрыть площадку"
            style={SITE_LENS_STYLE}
          />
        </span>
      )}
    </div>
  );
}

// Якорь родной рамки: невидимый прямоугольник рамки контейнера УРОВНЯ, несущий только
// точки стыковки. Саму рамку рисует оверлей LevelBoundary (живой bbox-follow за драгом),
// поэтому здесь ни границы, ни подписи — иначе рамка двоилась бы.
function FrameDockNode({ id }: NodeProps<FrameDockRFNode>) {
  return (
    <div style={{ width: "100%", height: "100%", pointerEvents: "none" }}>
      <FrameHandles nodeId={id} />
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
  frame: FrameNode as ComponentType<NodeProps>,
  site: SiteCardNode as ComponentType<NodeProps>,
  framedock: FrameDockNode as ComponentType<NodeProps>,
  spacer: SpacerNode as ComponentType<NodeProps>,
};
