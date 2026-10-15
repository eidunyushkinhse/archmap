// Подсказки перетаскивания шаблона узла из палитры поверх холста (в координатах графа —
// ViewportPortal, масштабируются вместе с зумом). Вынесено из разметки LevelGraph
// (аудит F-1); состояние дропа ведёт useTemplateDrop.
import { ViewportPortal } from "@xyflow/react";
import type { NodeShape } from "../../types";
import { NODE_W, NODE_H } from "./constants";
import { NodeShapeSvg } from "./shapes";
import type { DropFrame } from "./interaction/useTemplateDrop";

type Rect = DropFrame["rect"];

export default function DropOverlays({ preview, targetFrame, emptyFrame }: {
  // Превью будущего узла: форма и левый-верхний угол; null — шаблон не тянут.
  preview: { shape: NodeShape; x: number; y: number } | null;
  // Раскрытая рамка под курсором — узел станет ребёнком её контейнера.
  targetFrame: DropFrame | null;
  // Рамка уровня, когда слой пуст.
  emptyFrame: Rect | undefined;
}) {
  // ПРИГЛАШАЮЩАЯ РАМКА ПУСТОГО СЛОЯ (эпик «связи, упирающиеся в рамку»): пока тянут
  // шаблон, её внутренность светится зелёным — «первый узел кладут сюда»; когда центр
  // будущего узла оказывается внутри, зелёный становится выразительнее.
  // Подсветка ЧИСТО ВИЗУАЛЬНАЯ (canvas.md CV20a): в цели дропа рамка уровня не входит и
  // семантику не меняет — на пустом слое любой дроп и так создаёт ребёнка контейнера,
  // чью рамку видно. Хит-тест — тот же, что у рамок-целей: центр будущего узла в rect.
  const emptyFrameHit = !!emptyFrame && !!preview && (() => {
    const cx = preview.x + NODE_W / 2, cy = preview.y + NODE_H / 2;
    const r = emptyFrame;
    return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
  })();

  return (
    <>
      {/* Превью будущего узла: пустая рамка-форма с прозрачным телом — показывает
          точное место создания. */}
      {preview && (
        <ViewportPortal>
          <div
            style={{
              position: "absolute",
              left: preview.x,
              top: preview.y,
              width: NODE_W,
              height: NODE_H,
              pointerEvents: "none",
              zIndex: 5,
              opacity: 0.85,
            }}
          >
            <NodeShapeSvg shape={preview.shape} bg="transparent" stroke="#475569" outline />
          </div>
        </ViewportPortal>
      )}
      {/* Приглашение пустого слоя: пока тянут шаблон, внутренность рамки родителя
          светится зелёным; когда центр будущего узла внутри — заметнее. */}
      {emptyFrame && preview && (
        <ViewportPortal>
          <div
            // стабильный хук для тестов: idle — приглашение, hit — центр узла внутри
            data-empty-frame-hint={emptyFrameHit ? "hit" : "idle"}
            style={{
              position: "absolute",
              left: emptyFrame.x,
              top: emptyFrame.y,
              width: emptyFrame.w,
              height: emptyFrame.h,
              // border-box + радиус 12 — как у .lg-frame: заливка ложится ровно внутрь
              boxSizing: "border-box",
              pointerEvents: "none",
              zIndex: 4,
              borderRadius: 12,
              background: emptyFrameHit ? "rgba(34, 197, 94, 0.16)" : "rgba(34, 197, 94, 0.06)",
              border: `2px solid ${emptyFrameHit ? "#22c55e" : "rgba(34, 197, 94, 0.35)"}`,
              transition: "background 0.12s ease, border-color 0.12s ease",
            }}
          />
        </ViewportPortal>
      )}
      {/* Индикация цели дропа в раскрытую рамку: подсвечиваем её контур («рамка
          раскрывается шире под новый узел» — узел станет ребёнком её контейнера). */}
      {targetFrame && (
        <ViewportPortal>
          <div
            style={{
              position: "absolute",
              left: targetFrame.rect.x,
              top: targetFrame.rect.y,
              width: targetFrame.rect.w,
              height: targetFrame.rect.h,
              // border-box + тот же радиус (12), что у .lg-frame — контур подсветки
              // ложится ровно на контур рамки (иначе бордер уезжал наружу на 2px).
              boxSizing: "border-box",
              pointerEvents: "none",
              zIndex: 4,
              borderRadius: 12,
              border: "2px solid #6366f1",
              background: "rgba(99, 102, 241, 0.06)",
            }}
          />
        </ViewportPortal>
      )}
    </>
  );
}
