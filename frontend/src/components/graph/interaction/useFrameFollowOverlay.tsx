// ЖИВОЙ bbox-follow рамок при драге (2026-07-08, переписан на оверлей; вынесен из
// LevelGraph при распиле Ф2 аудита 2026-07-09).
//
// Рамки НЕ таскаются (их rect производен от детей), но при драге ребёнка рамка
// обязана следовать за содержимым прямо во время жеста. РЕАЛИЗАЦИЯ — ОВЕРЛЕЙ, а не
// движение RF-узла рамки: прежний вариант каждый тик двигал рамку в стейте и
// компенсировал rel ВСЕХ её детей — (а) каскад ре-рендеров узлов ронял FPS драга,
// (б) RF ведёт позицию таскаемого относительно ДВИЖУЩЕЙСЯ рамки — накапливался
// дрейф и узел «телепортировался» на сотни px. Теперь на время жеста RF-рамки
// предков скрываются (opacity 0, один setState), их живой прямоугольник рисуют
// лёгкие div-ы в ViewportPortal, обновляемые ИМПЕРАТИВНО через ref (ноль рендеров
// на тик), а финальная геометрия применяется одним setState на отпускании.
// Паддинги рамки снимаются на старте жеста (рамка = bbox прямых детей + константные
// отступы); обход рамок — глубокие первыми (изменение вложенной двигает объемлющую).
import { useCallback, useRef, useState, type Dispatch, type SetStateAction, type ReactElement } from "react";
import type { Node as RFNode } from "@xyflow/react";
import { NODE_W, NODE_H } from "../constants";
import { absPositionOf } from "../absPos";

interface Params {
  rfNodes: RFNode[];
  setRfNodes: Dispatch<SetStateAction<RFNode[]>>;
  getNodes: () => RFNode[];
}

type Pad = { l: number; t: number; r: number; b: number };
type OverlayFrame = { id: string; name: string; x: number; y: number; w: number; h: number };

const rfSize = (n: RFNode): { w: number; h: number } => ({
  w: n.measured?.width ?? (typeof n.width === "number" ? n.width : NODE_W),
  h: n.measured?.height ?? (typeof n.height === "number" ? n.height : NODE_H),
});

export function useFrameFollowOverlay({ rfNodes, setRfNodes, getNodes }: Params) {
  const framePadsRef = useRef<Map<string, Pad>>(new Map());
  // Рамки, скрытые на текущий жест (их рисует оверлей) + div-ы оверлея по id.
  const affectedFramesRef = useRef<Set<string>>(new Set());
  const overlayElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const [overlayFrames, setOverlayFrames] = useState<OverlayFrame[]>([]);

  // Паддинги рамок на старте жеста: рамка = bbox прямых детей + эти отступы.
  const snapshotPads = useCallback(() => {
    const pads = new Map<string, Pad>();
    for (const f of rfNodes) {
      if (f.type !== "frame") continue;
      const kids = rfNodes.filter((k) => k.parentId === f.id && k.type !== "spacer");
      if (kids.length === 0) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const k of kids) {
        const { w, h } = rfSize(k);
        minX = Math.min(minX, k.position.x); minY = Math.min(minY, k.position.y);
        maxX = Math.max(maxX, k.position.x + w); maxY = Math.max(maxY, k.position.y + h);
      }
      const { w: fw, h: fh } = rfSize(f);
      pads.set(f.id, { l: minX, t: minY, r: fw - maxX, b: fh - maxY });
    }
    framePadsRef.current = pads;
  }, [rfNodes]);

  // Старт жеста: рамки-предки таскаемых скрываются, оверлей получает их стартовые rect.
  const begin = useCallback((grp: RFNode[]) => {
    const byId = new Map(rfNodes.map((n) => [n.id, n]));
    const affected = new Set<string>();
    for (const n of grp) {
      let pid = n.parentId;
      while (pid) {
        const p = byId.get(pid);
        if (!p) break;
        if (p.type === "frame") affected.add(p.id);
        pid = p.parentId;
      }
    }
    affectedFramesRef.current = affected;
    if (affected.size === 0) { setOverlayFrames([]); return; }
    setOverlayFrames([...affected].map((id) => {
      const f = byId.get(id)!;
      const abs = absPositionOf(f, byId);
      const { w, h } = rfSize(f);
      return { id, name: (f.data as { name?: string }).name ?? "", x: abs.x, y: abs.y, w, h };
    }));
    setRfNodes((prev) => prev.map((n) =>
      affected.has(n.id) ? { ...n, style: { ...n.style, opacity: 0 } } : n,
    ));
  }, [rfNodes, setRfNodes]);

  // Тик жеста: живой bbox затронутых рамок → императивно в div-ы оверлея. Ноль setState.
  // Позиции читаем из RF-стора (стейт прошлого тика), таскаемые подменяем свежими из
  // аргумента onNodeDrag; рамки в стейте на время жеста неподвижны, поэтому абсолюты
  // детей корректны по построению.
  const follow = useCallback((dragged: RFNode[]) => {
    const affected = affectedFramesRef.current;
    if (affected.size === 0) return;
    const pads = framePadsRef.current;
    const els = overlayElsRef.current;
    const nodes = getNodes();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const d of dragged) {
      const cur = byId.get(d.id);
      if (cur) byId.set(d.id, { ...cur, position: d.position });
    }
    const depthOf = (n: RFNode): number => {
      let d = 0, pid = n.parentId;
      while (pid) { d++; pid = byId.get(pid)?.parentId; }
      return d;
    };
    const kidsOf = new Map<string, RFNode[]>();
    for (const n of byId.values()) {
      if (!n.parentId || n.type === "spacer") continue;
      (kidsOf.get(n.parentId) ?? kidsOf.set(n.parentId, []).get(n.parentId)!).push(n);
    }
    // live-rect рамок в АБСОЛЮТЕ, глубокие первыми (объемлющая видит live-rect вложенной)
    const live = new Map<string, { x: number; y: number; w: number; h: number }>();
    const frames = [...byId.values()].filter((n) => n.type === "frame" && affected.has(n.id))
      .sort((a, b) => depthOf(b) - depthOf(a));
    for (const f of frames) {
      const pad = pads.get(f.id);
      const kids = kidsOf.get(f.id);
      if (!pad || !kids || kids.length === 0) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const k of kids) {
        const lr = live.get(k.id);
        const abs = lr ?? { ...absPositionOf(k, byId), ...rfSize(k) };
        const { w, h } = lr ?? rfSize(k);
        minX = Math.min(minX, abs.x); minY = Math.min(minY, abs.y);
        maxX = Math.max(maxX, abs.x + w); maxY = Math.max(maxY, abs.y + h);
      }
      const rect = {
        x: minX - pad.l, y: minY - pad.t,
        w: maxX - minX + pad.l + pad.r, h: maxY - minY + pad.t + pad.b,
      };
      live.set(f.id, rect);
      const el = els.get(f.id);
      if (el) {
        el.style.left = `${rect.x}px`; el.style.top = `${rect.y}px`;
        el.style.width = `${rect.w}px`; el.style.height = `${rect.h}px`;
      }
    }
  }, [getNodes]);

  // Отпускание: финальная геометрия рамок применяется ОДНИМ setState (copy-on-write:
  // клонируются только рамки с изменившимся bbox и их дети при сдвиге origin — rel-
  // компенсация держит абсолюты детей), скрытые рамки возвращают видимость, оверлей
  // гаснет. Дальше обычный персист — конвейер пересчитает всё начисто.
  const finalize = useCallback(() => {
    const affected = affectedFramesRef.current;
    affectedFramesRef.current = new Set();
    setOverlayFrames([]);
    if (affected.size === 0) return;
    setRfNodes((prev) => {
      const pads = framePadsRef.current;
      const patched = new Map<string, RFNode>();
      const byId = new Map(prev.map((n) => [n.id, n]));
      const cur = (id: string): RFNode | undefined => patched.get(id) ?? byId.get(id);
      const unhide = (n: RFNode): RFNode => {
        if (!affected.has(n.id) || !n.style || n.style.opacity === undefined) return n;
        const rest = { ...n.style };
        delete rest.opacity;
        return { ...n, style: rest };
      };
      const depthOf = (n: RFNode): number => {
        let d = 0, pid = n.parentId;
        while (pid) { d++; pid = byId.get(pid)?.parentId; }
        return d;
      };
      const frames = prev.filter((n) => n.type === "frame").sort((a, b) => depthOf(b) - depthOf(a));
      const kidsOf = new Map<string, RFNode[]>();
      for (const n of prev) {
        if (!n.parentId || n.type === "spacer") continue;
        (kidsOf.get(n.parentId) ?? kidsOf.set(n.parentId, []).get(n.parentId)!).push(n);
      }
      for (const f of frames) {
        const pad = pads.get(f.id);
        const kids0 = kidsOf.get(f.id);
        if (!pad || !kids0 || kids0.length === 0) continue;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const k0 of kids0) {
          const k = cur(k0.id)!;
          const { w, h } = rfSize(k);
          minX = Math.min(minX, k.position.x); minY = Math.min(minY, k.position.y);
          maxX = Math.max(maxX, k.position.x + w); maxY = Math.max(maxY, k.position.y + h);
        }
        const dx = minX - pad.l, dy = minY - pad.t;
        const nw = maxX - minX + pad.l + pad.r, nh = maxY - minY + pad.t + pad.b;
        const fc = cur(f.id)!;
        const { w: fw, h: fh } = rfSize(fc);
        const moved = Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5;
        if (!moved && Math.abs(nw - fw) < 0.5 && Math.abs(nh - fh) < 0.5) continue;
        patched.set(f.id, {
          ...fc,
          position: { x: fc.position.x + dx, y: fc.position.y + dy },
          width: nw, height: nh,
          ...(fc.measured ? { measured: { width: nw, height: nh } } : null),
        });
        // компенсация rel нужна только при сдвиге origin рамки; рост вправо/вниз
        // (dx=dy=0) детей не трогает
        if (moved) {
          for (const k0 of kids0) {
            const k = cur(k0.id)!;
            patched.set(k.id, { ...k, position: { x: k.position.x - dx, y: k.position.y - dy } });
          }
        }
      }
      return prev.map((n) => unhide(patched.get(n.id) ?? n));
    });
  }, [setRfNodes]);

  // Живой оверлей: div-ы в ViewportPortal вместо скрытых RF-рамок; обновляются
  // императивно из follow (без setState на тик). null — оверлей не нужен.
  const overlay: ReactElement | null = overlayFrames.length === 0 ? null : (
    <>
      {overlayFrames.map((f) => (
        <div
          key={f.id}
          ref={(el) => {
            if (el) overlayElsRef.current.set(f.id, el);
            else overlayElsRef.current.delete(f.id);
          }}
          style={{
            position: "absolute", left: f.x, top: f.y, width: f.w, height: f.h,
            border: "1px dashed #9ca3af", borderRadius: 12, background: "transparent",
            boxSizing: "border-box", pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute", left: 10, bottom: 8, fontSize: 12, fontWeight: 600,
              color: "#64748b", background: "#fff", padding: "2px 8px", borderRadius: 5,
              border: "1px solid #e5e7eb", whiteSpace: "nowrap", pointerEvents: "none",
            }}
          >
            🔍 {f.name}
          </div>
        </div>
      ))}
    </>
  );

  return { snapshotPads, begin, follow, finalize, overlay };
}
