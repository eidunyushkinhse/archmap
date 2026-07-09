// Магнитное выравнивание узлов по центру при драге + персист позиции по отпусканию.
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { MouseEvent } from "react";
import type { Node as RFNode, NodeChange } from "@xyflow/react";
import type { History } from "./useHistory";
import { snapNode, nodeSize } from "./snap";
import type { SpacingGuide } from "./distribute";
import { computeFrames, type FrameRect } from "../layout/frames";
import { framedBlockRefs } from "../frameChains";
import { clampOutOfNativeFrames, pushOut } from "../layout/keepGhostsOut";
import { clampOutOfNodeRects } from "../layout/separateNodes";
import type { Rect } from "../layout/overlapConstraints";
import { KEEPOUT_GAP } from "../constants";
import { absPositionOf } from "../absPos";
import type { GhostData, ContainerData } from "../types";
import type { AncestorRef } from "../../../types";
import type { Guides } from "./useAlignmentGuides";

interface Params {
  rfNodes: RFNode[];
  onNodesChange: (changes: NodeChange<RFNode>[]) => void;
  setGuides: Dispatch<SetStateAction<Guides>>;
  isArchitect: boolean;
  isContext: boolean;
  // breadcrumb-предки уровня — нужны для запрета задвинуть гостя в чужую родную рамку
  ancestorIds: string[];
  ancestorNames: string[];
  // Единая запись раскладки вида (R3): позиции ЛЮБЫХ перетянутых сущностей —
  // локалов, гостей и свёрнутых контейнеров — уходят одним батчем view_layout
  // (персист + зеркало делает LevelGraph.commitLayout).
  commitLayout: (items: Record<string, { x: number; y: number }>) => void;
  // запись действия в историю Undo/Redo (перемещение группы = одна команда)
  push?: History["push"];
}

export function useSnapAlignment({
  rfNodes, onNodesChange, setGuides, isArchitect, isContext,
  ancestorIds, ancestorNames, commitLayout, push,
}: Params) {
  // Позиции узлов на момент старта драга — «старое» состояние для инверсии перемещения.
  // Заполняется noteDragStart на onNodeDragStart/onSelectionDragStart (до сдвига).
  // Храним АБСОЛЮТ вида: дети compound-рамок (R4) несут относительные координаты,
  // а undo/redo переигрывают commitLayout — он ждёт абсолюта.
  const startPos = useRef<Map<string, { x: number; y: number }>>(new Map());
  const noteDragStart = useCallback((group: RFNode[]) => {
    const byId = new Map(rfNodes.map((n) => [n.id, n]));
    startPos.current = new Map(group.map((n) => [n.id, absPositionOf(n, byId)]));
  }, [rfNodes]);
  // Живой запрет въезда в чужую РАСКРЫТУЮ рамку (R5-инвариант: узел, не
  // относящийся к рамке, не лежит внутри неё). Раскрытые рамки — frame-узлы
  // канвы (их rect известен); субъект — узел ЛЮБОГО типа или целая рамка.
  // Свои рамки (предки субъекта) и вложенные в субъект — пропускаются.
  const clampOutOfCompound = useCallback(
    (subjectId: string, pos: { x: number; y: number }, w: number, h: number): { x: number; y: number } => {
      const byId = new Map(rfNodes.map((n) => [n.id, n]));
      const isOwn = (frameId: string): boolean => {
        let p = byId.get(subjectId)?.parentId;
        while (p) { if (p === frameId) return true; p = byId.get(p)?.parentId; }
        let q = byId.get(frameId)?.parentId;
        while (q) { if (q === subjectId) return true; q = byId.get(q)?.parentId; }
        return false;
      };
      let out = pos;
      for (const f of rfNodes) {
        if (f.type !== "frame" || f.id === subjectId || isOwn(f.id)) continue;
        const fp = absPositionOf(f, byId);
        const { w: fw, h: fh } = nodeSize(f);
        const push = pushOut(
          { minX: out.x, minY: out.y, maxX: out.x + w, maxY: out.y + h },
          { minX: fp.x, minY: fp.y, maxX: fp.x + fw, maxY: fp.y + fh },
          KEEPOUT_GAP,
        );
        if (push) out = { x: out.x + push.dx, y: out.y + push.dy };
      }
      return out;
    },
    [rfNodes],
  );

  // Живой запрет НАЛОЖЕНИЯ узлов: субъект скользит вдоль чужих узлов, как вдоль
  // рамок. Соседи собираются в АБСОЛЮТНЫХ координатах (дети compound-рамок в
  // rfNodes относительны); exclude — группа текущего жеста (потомки рамки при её
  // драге и т.п.), рамки и распорки соседями не считаются (у рамок свой кламп).
  const clampOutOfNodes = useCallback(
    (
      subjectId: string,
      pos: { x: number; y: number },
      w: number,
      h: number,
      exclude?: Set<string>,
    ): { x: number; y: number } => {
      const byId = new Map(rfNodes.map((n) => [n.id, n]));
      const others: Rect[] = [];
      for (const o of rfNodes) {
        if (o.id === subjectId || exclude?.has(o.id)) continue;
        if (o.type !== "block" && o.type !== "ghost" && o.type !== "container") continue;
        const op = absPositionOf(o, byId);
        const { w: ow, h: oh } = nodeSize(o);
        others.push({ minX: op.x, minY: op.y, maxX: op.x + ow, maxY: op.y + oh });
      }
      return clampOutOfNodeRects(pos, w, h, others);
    },
    [rfNodes],
  );

  // Нативные рамки уровня по текущим узлам — общий вход запрета проникновения гостей
  // (живой clamp при драге и clamp при отпускании). Запретная рамка гостя не включает
  // его членом, поэтому от его собственной позиции не зависит. Позиции — абсолютные
  // (дети compound-рамок в rfNodes относительны, R4).
  const levelFrames = useCallback((): FrameRect[] => {
    const blocks = rfNodes.filter((n) => n.type === "block");
    const externals = rfNodes.filter((n) => n.type === "ghost" || n.type === "container");
    const extAncestors = (n: RFNode): AncestorRef[] =>
      n.type === "ghost"
        ? (n.data as GhostData).appNode.ancestors ?? []
        : ((n.data as ContainerData).ancestors ?? []);
    const byId = new Map(rfNodes.map((n) => [n.id, n]));
    // Дети РАСКРЫТЫХ РАМОК (compound): без синтеза цепочек модель нативной рамки не
    // видит колец раскрытых локалов и живой кламп держит гостей от МЕНЬШЕЙ рамки,
    // чем нарисована (см. frameChains.ts — единый источник, общий с LevelBoundary).
    const framedBlocks = framedBlockRefs(rfNodes, ancestorIds, ancestorNames);
    return computeFrames({
      localIds: blocks.map((b) => b.id),
      externals: [...externals.map((n) => ({ id: n.id, ancestors: extAncestors(n) })), ...framedBlocks],
      pos: (id) => { const n = byId.get(id); return n ? absPositionOf(n, byId) : undefined; },
      ancestorIds, ancestorNames,
    });
  }, [rfNodes, ancestorIds, ancestorNames]);

  // Персист позиций ВСЕХ перетянутых узлов. При мультивыделении RF тащит группу, но
  // раньше сохранялся только узел-«ручка» — после ближайшего пересчёта раскладки
  // соседи откатывались на старые сохранённые координаты. Поэтому сохраняем каждый.
  // Снап применяем только к одиночному узлу: групповой снап считал бы притяжку
  // каждого к своим соседям и исказил бы взаимные интервалы перемещаемой группы.
  // R3: локалы, гости и контейнеры пишутся ЕДИНООБРАЗНО — батчем view_layout.
  const persistGroup = useCallback(
    (group: RFNode[]) => {
      if (isContext) return; // контекст read-only — перетаскивания не сохраняем
      if (!isArchitect) return;
      const single = group.length === 1;
      // нативные рамки считаем один раз на группу — нужны только при наличии
      // гостей/контейнеров/раскрытых рамок (локалам кламп не нужен)
      const frames =
        group.some((n) => n.type === "ghost" || n.type === "container" || n.type === "frame")
          ? levelFrames()
          : [];
      // Перемещения, реально изменившие позицию (для записи в историю Undo/Redo).
      type Move = { id: string; old: { x: number; y: number }; next: { x: number; y: number } };
      const moves: Move[] = [];
      const patch: Record<string, { x: number; y: number }> = {};

      const byId = new Map(rfNodes.map((n) => [n.id, n]));
      for (const n of group) {
        // Рамки не таскаются (запрет движения рамок, 2026-07-08) — прежний батч-персист
        // потомков при драге рамки (R4.2) умер вместе с draggable.
        if (n.type !== "block" && n.type !== "ghost" && n.type !== "container") continue;
        // Ребёнок compound-рамки (R4): позиция драга ОТНОСИТЕЛЬНА рамке — живой снап
        // в этой системе неприменим (соседи в абсолюте). Персистим АБСОЛЮТ (конвейер
        // владеет позициями вида в абсолюте), прогнав через тот же keep-out-кламп:
        // иначе сохранённое «желание» расходилось бы с рендером (enforce прибивал бы
        // узел к границе чужой родной рамки на каждом прогоне раскладки). Точный
        // группово-жёсткий кламп остаётся за enforce; жёсткая группа умрёт в R4.2.
        if (n.parentId) {
          const { w: cw, h: ch } = nodeSize(n);
          const abs = clampOutOfNodes(
            n.id,
            clampOutOfCompound(
              n.id, clampOutOfNativeFrames(n.id, absPositionOf(n, byId), frames), cw, ch,
            ),
            cw, ch,
          );
          patch[n.id] = abs;
          const start = startPos.current.get(n.id);
          if (start && (start.x !== abs.x || start.y !== abs.y)) {
            moves.push({ id: n.id, old: { x: start.x, y: start.y }, next: abs });
          }
          continue;
        }
        const { w: dw, h: dh } = nodeSize(n);
        let px = n.position.x;
        let py = n.position.y;
        if (single) {
          // ВАЖНО: n.position здесь — «сырая» позиция драга React Flow. Наши снап-правки
          // из onNodesChange меняют ОТРИСОВАННЫЙ стейт (rfNodes), но внутренний трекер
          // драга RF их не видит — координата без притяжки. Пересчитываем тот же снап,
          // чтобы СОХРАНИТЬ ровно то, что показывала направляющая.
          const { snapCx, snapCy } = snapNode(px + dw / 2, py + dh / 2, dw, dh, rfNodes, n.id);
          px = snapCx - dw / 2;
          py = snapCy - dh / 2;
        }
        if (n.type === "ghost" || n.type === "container") {
          // Строгий запрет проникновения в чужую родную рамку держит живой clamp в
          // handleNodesChange; здесь повторяем его для СОХРАНЯЕМОЙ позиции.
          const clamped = clampOutOfNativeFrames(n.id, { x: px, y: py }, frames);
          px = clamped.x;
          py = clamped.y;
        }
        // R5: чужие раскрытые рамки и чужие узлы запретны (повтор живых клампов);
        // при мультидраге узловой кламп не применяем (порвал бы жёсткую группу —
        // конвейер разведёт и персистнет после отпускания)
        {
          const groupIds = new Set(group.map((m) => m.id));
          let cc = clampOutOfCompound(n.id, { x: px, y: py }, dw, dh);
          if (single) cc = clampOutOfNodes(n.id, cc, dw, dh, groupIds);
          if (cc.x !== px || cc.y !== py) {
            onNodesChange([{ id: n.id, type: "position", position: cc }]);
            px = cc.x; py = cc.y;
          }
        }
        patch[n.id] = { x: px, y: py };
        const start = startPos.current.get(n.id);
        if (start && (start.x !== px || start.y !== py)) {
          moves.push({ id: n.id, old: { x: start.x, y: start.y }, next: { x: px, y: py } });
        }
      }
      if (Object.keys(patch).length > 0) commitLayout(patch);

      // Записываем перемещение в историю одной командой (вся перетянутая группа). undo/redo
      // переигрывают тот же персист+зеркало с нужной АБСОЛЮТНОЙ позицией. Позиции уже
      // валидны → повторный clamp не нужен.
      if (push && moves.length > 0) {
        const apply = (which: "old" | "next") => {
          commitLayout(Object.fromEntries(moves.map((m) => [m.id, m[which]])));
        };
        push({
          label: moves.length > 1 ? "Перемещение группы" : "Перемещение",
          undo: () => apply("old"),
          redo: () => apply("next"),
        });
      }
    },
    [isArchitect, isContext, commitLayout, onNodesChange, levelFrames, clampOutOfCompound, clampOutOfNodes, rfNodes, push],
  );

  // Отпускание драга одиночного узла (или узла-«ручки» мультивыделения). RF отдаёт
  // все перетянутые узлы третьим аргументом — сохраняем их все.
  const handleNodeDragStop = useCallback(
    (_event: MouseEvent, rfNode: RFNode, draggedNodes: RFNode[]) => {
      setGuides({ x: null, y: null, spacing: [] }); // прячем направляющие
      persistGroup(draggedNodes.length > 0 ? draggedNodes : [rfNode]);
    },
    [setGuides, persistGroup],
  );

  // Отпускание драга рамки выделения (NodesSelection) — RF тащит всю группу через
  // отдельный обработчик. Сохраняем те же узлы.
  const handleSelectionDragStop = useCallback(
    (_event: MouseEvent, draggedNodes: RFNode[]) => {
      setGuides({ x: null, y: null, spacing: [] });
      persistGroup(draggedNodes);
    },
    [setGuides, persistGroup],
  );

  // Магнитное выравнивание по центру при драге: перехватываем position-изменения
  // и, если центр перетаскиваемого узла оказался ближе SNAP_THRESHOLD к центру
  // соседа по X или Y, сдвигаем координату так, чтобы центры совпали. По осям
  // независимо — X может «прилипнуть» к одному соседу, Y к другому. Снапим и
  // финальное изменение (отпускание), чтобы узел остался ровно на магнитной
  // координате. Пока идёт драг — публикуем координаты центральных направляющих.
  const handleNodesChange = useCallback(
    (changes: NodeChange<RFNode>[]) => {
      let guideX: number | null = null;
      let guideY: number | null = null;
      let guideSpacing: SpacingGuide[] = [];
      // нативные рамки считаем лениво — только если тащат гостя/контейнер
      let frames: FrameRect[] | null = null;
      // Мультидраг (тянут несколько выделенных узлов сразу): магнитный снап и
      // направляющие отключаем — групповой снап притянул бы каждый узел к своим
      // соседям и исказил бы взаимные интервалы группы. Гостей всё равно держим вне
      // чужих рамок. Считаем по числу одновременных position-изменений драга.
      const multiDrag =
        changes.filter((c) => c.type === "position" && c.dragging).length > 1;
      const snapped = changes.map((change) => {
        if (change.type !== "position" || !change.position) return change;
        const dragged = rfNodes.find((n) => n.id === change.id);
        // Ребёнок compound-рамки (R4): координаты драга — в системе рамки. ЖИВОЙ
        // кламп (2026-07-08, бывший хвост «кламп только на отпускании»): переводим
        // в абсолют, применяем ПОЛНЫЙ набор запретов (родные рамки + чужие раскрытые
        // рамки + все чужие узлы — те же клампы, что и персист на отпускании) и
        // возвращаем в rel. Соседи внутри клампов сами считаются в абсолюте.
        if (dragged?.parentId) {
          const byId = new Map(rfNodes.map((n) => [n.id, n]));
          const parent = byId.get(dragged.parentId);
          if (!parent) return change;
          const pAbs = absPositionOf(parent, byId);
          const { w: cw, h: ch } = nodeSize(dragged);
          frames ??= levelFrames();
          let abs = { x: pAbs.x + change.position.x, y: pAbs.y + change.position.y };
          // магнитное выравнивание (2026-07-08, бывший пробел «дети не выравниваются»):
          // снап считает соседей в абсолюте — ребёнку он доступен так же, как топ-узлу
          let baseX = abs.x, baseY = abs.y, hitX = false, hitY = false;
          let childSpacing: SpacingGuide[] = [];
          let snapCx = 0, snapCy = 0;
          if (!multiDrag) {
            const s = snapNode(abs.x + cw / 2, abs.y + ch / 2, cw, ch, rfNodes, dragged.id);
            snapCx = s.snapCx; snapCy = s.snapCy;
            baseX = s.snapCx - cw / 2; baseY = s.snapCy - ch / 2;
            abs = { x: baseX, y: baseY };
            hitX = s.hitX; hitY = s.hitY; childSpacing = s.spacing;
          }
          abs = clampOutOfNativeFrames(dragged.id, abs, frames);
          abs = clampOutOfCompound(dragged.id, abs, cw, ch);
          abs = clampOutOfNodes(dragged.id, abs, cw, ch);
          if (change.dragging && !multiDrag) {
            if (hitX && abs.x === baseX) guideX = snapCx;
            if (hitY && abs.y === baseY) guideY = snapCy;
            guideSpacing = childSpacing.filter((g) => (g.axis === "x" ? abs.x === baseX : abs.y === baseY));
          }
          return { ...change, position: { x: abs.x - pAbs.x, y: abs.y - pAbs.y } };
        }
        // Рамки не таскаются (запрет движения рамок, 2026-07-08) — ветка драга
        // рамки R4.2 умерла вместе с draggable.
        const { w: dw, h: dh } = nodeSize(dragged);
        let x = change.position.x, y = change.position.y;
        const isExternal = dragged && (dragged.type === "ghost" || dragged.type === "container");
        if (multiDrag) {
          // Без снапа; гостям/контейнерам только запрет проникновения в чужие рамки.
          if (isExternal) {
            frames ??= levelFrames();
            const c = clampOutOfNativeFrames(change.id, { x, y }, frames);
            x = c.x; y = c.y;
          }
          ({ x, y } = clampOutOfCompound(change.id, { x, y }, dw, dh));
          return { ...change, position: { x, y } };
        }
        // Центр узла в текущей (перетаскиваемой) позиции
        const cx = x + dw / 2;
        const cy = y + dh / 2;
        const { snapCx, snapCy, hitX, hitY, spacing } = snapNode(cx, cy, dw, dh, rfNodes, change.id);
        // Координата угла после притяжки (позиция узла = левый-верхний угол)
        const baseX = snapCx - dw / 2, baseY = snapCy - dh / 2;
        x = baseX; y = baseY;
        // Строгий запрет проникновения: гостя/контейнер НЕ пускаем внутрь чужой родной
        // рамки прямо во время драга — он скользит вдоль её края (clamp к ближайшей грани).
        if (isExternal) {
          frames ??= levelFrames();
          const c = clampOutOfNativeFrames(change.id, { x, y }, frames);
          x = c.x; y = c.y;
        }
        // R5: узел любого типа (и локал!) не въезжает в чужую раскрытую рамку
        ({ x, y } = clampOutOfCompound(change.id, { x, y }, dw, dh));
        // и не накладывается на другие узлы (скольжение вдоль)
        ({ x, y } = clampOutOfNodes(change.id, { x, y }, dw, dh));
        // Направляющие — только при активном драге и только по оси, которую clamp не двигал
        // (иначе линия показывала бы притяжку там, где узел уже оттолкнут рамкой).
        if (change.dragging) {
          if (hitX && x === baseX) guideX = snapCx;
          if (hitY && y === baseY) guideY = snapCy;
          // Индикаторы зазоров — по оси ряда (x→ось X, y→ось Y), тоже только если
          // clamp не сдвинул узел по этой оси.
          guideSpacing = spacing.filter((g) => (g.axis === "x" ? x === baseX : y === baseY));
        }
        return { ...change, position: { x, y } };
      });
      setGuides((prev) => {
        // Пустые spacing-массивы считаем равными, чтобы не плодить ререндеры в
        // обычном случае (ничего не примагнитилось по зазорам).
        const sameSpacing =
          prev.spacing === guideSpacing ||
          (prev.spacing.length === 0 && guideSpacing.length === 0);
        return prev.x === guideX && prev.y === guideY && sameSpacing
          ? prev
          : { x: guideX, y: guideY, spacing: guideSpacing };
      });
      onNodesChange(snapped);
    },
    [rfNodes, onNodesChange, setGuides, levelFrames, clampOutOfCompound, clampOutOfNodes],
  );

  return { handleNodesChange, handleNodeDragStop, handleSelectionDragStop, noteDragStart };
}
