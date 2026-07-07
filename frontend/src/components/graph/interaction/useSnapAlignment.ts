// Магнитное выравнивание узлов по центру при драге + персист позиции по отпусканию.
import { useCallback, useRef, type Dispatch, type SetStateAction } from "react";
import type { MouseEvent } from "react";
import type { Node as RFNode, NodeChange } from "@xyflow/react";
import type { History } from "./useHistory";
import { snapNode, nodeSize } from "./snap";
import type { SpacingGuide } from "./distribute";
import { computeFrames, type FrameRect } from "../layout/frames";
import { clampOutOfNativeFrames, pushOut } from "../layout/keepGhostsOut";
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
    return computeFrames({
      localIds: blocks.map((b) => b.id),
      externals: externals.map((n) => ({ id: n.id, ancestors: extAncestors(n) })),
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
        // Драг РАМКИ (R4.2): RF везёт потомков нативно (их rel не менялись весь
        // жест) — персистим новые АБСОЛЮТЫ всех узлов-потомков. Саму рамку не
        // персистим: её позиция производна от детей (bbox следующего прогона
        // раскладки сойдётся с новым положением). Кламп от чужих родных рамок
        // уже применил живой clamp в handleNodesChange (по полному rect рамки).
        // Позицию рамки берём из АРГУМЕНТА RF (свежая на момент отпускания).
        if (n.type === "frame") {
          const freshById = new Map(byId);
          const live = byId.get(n.id);
          if (live) freshById.set(n.id, { ...live, position: n.position });
          const isDescendant = (x: RFNode): boolean => {
            let p = x.parentId ? freshById.get(x.parentId) : undefined;
            while (p) {
              if (p.id === n.id) return true;
              p = p.parentId ? freshById.get(p.parentId) : undefined;
            }
            return false;
          };
          for (const child of rfNodes) {
            if (child.type !== "ghost" && child.type !== "container") continue;
            if (!isDescendant(child)) continue;
            const abs = absPositionOf(child, freshById);
            patch[child.id] = abs;
            const start = startPos.current.get(child.id);
            if (start && (start.x !== abs.x || start.y !== abs.y)) {
              moves.push({ id: child.id, old: { x: start.x, y: start.y }, next: abs });
            }
          }
          continue;
        }
        if (n.type !== "block" && n.type !== "ghost" && n.type !== "container") continue;
        // Ребёнок compound-рамки (R4): позиция драга ОТНОСИТЕЛЬНА рамке — живой снап
        // в этой системе неприменим (соседи в абсолюте). Персистим АБСОЛЮТ (конвейер
        // владеет позициями вида в абсолюте), прогнав через тот же keep-out-кламп:
        // иначе сохранённое «желание» расходилось бы с рендером (enforce прибивал бы
        // узел к границе чужой родной рамки на каждом прогоне раскладки). Точный
        // группово-жёсткий кламп остаётся за enforce; жёсткая группа умрёт в R4.2.
        if (n.parentId) {
          const { w: cw, h: ch } = nodeSize(n);
          const abs = clampOutOfCompound(
            n.id, clampOutOfNativeFrames(n.id, absPositionOf(n, byId), frames), cw, ch,
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
        // R5: чужие раскрытые рамки запретны для узла любого типа (повтор живого клампа)
        {
          const cc = clampOutOfCompound(n.id, { x: px, y: py }, dw, dh);
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
    [isArchitect, isContext, commitLayout, onNodesChange, levelFrames, clampOutOfCompound, rfNodes, push],
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
        // Ребёнок compound-рамки (R4): координаты драга — в системе рамки, снап к
        // абсолютным соседям и кламп неприменимы; RF ведёт узел как есть.
        if (dragged?.parentId) return change;
        // Драг РАМКИ (R4.2): без магнита, но с живым клампом по её ПОЛНОМУ rect.
        // Запретную родную рамку определяет ЧЛЕНСТВО ДЕТЕЙ (как в enforce): гость
        // с общим предком законно живёт внутри родных рамок до глубины членства —
        // кламп по самой рамке (не члену) ошибочно выталкивал бы её из всех.
        if (dragged?.type === "frame") {
          frames ??= levelFrames();
          const rep = rfNodes.find(
            (x) => x.parentId === dragged.id && (x.type === "ghost" || x.type === "container"),
          );
          const { w, h } = nodeSize(dragged);
          const c = clampOutOfNativeFrames(rep?.id ?? change.id, change.position, frames, w, h);
          return { ...change, position: clampOutOfCompound(change.id, c, w, h) };
        }
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
    [rfNodes, onNodesChange, setGuides, levelFrames, clampOutOfCompound],
  );

  return { handleNodesChange, handleNodeDragStop, handleSelectionDragStop, noteDragStart };
}
