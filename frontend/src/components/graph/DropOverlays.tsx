// Подсказки перетаскивания шаблона узла из палитры поверх холста (в координатах графа —
// ViewportPortal, масштабируются вместе с зумом). Вынесено из разметки LevelGraph
// (аудит F-1); состояние дропа ведёт useTemplateDrop. Цель броска проверяет тип (приёмка
// Ф12 2026-10-31, canvas.md CV20c): над местом, где тип невозможен, превью запретное, а
// если тип невозможен на уровне, принимающие его раскрытые рамки залиты зелёным.
import type { CSSProperties } from "react";
import { ViewportPortal } from "@xyflow/react";
import type { NodeShape } from "../../types";
import { NODE_W, NODE_H } from "./constants";
import { NodeShapeSvg } from "./shapes";
import type { DropFrame } from "./interaction/useTemplateDrop";
import { targetAccepts } from "./dropFrameTargets";
import type { DropEligible } from "./types";

type Rect = DropFrame["rect"];

// Зелёное приглашение «кладут сюда» — общее у пустого слоя (CV20a) и рамок-целей (CV20c):
// бледное, пока тянут, и выразительное, когда центр будущего узла внутри.
function inviteStyle(r: Rect, hit: boolean): CSSProperties {
  return {
    position: "absolute",
    left: r.x,
    top: r.y,
    width: r.w,
    height: r.h,
    // border-box + радиус 12 — как у .lg-frame: заливка ложится ровно внутрь
    boxSizing: "border-box",
    pointerEvents: "none",
    zIndex: 4,
    borderRadius: 12,
    background: hit ? "rgba(34, 197, 94, 0.16)" : "rgba(34, 197, 94, 0.06)",
    border: `2px solid ${hit ? "#22c55e" : "rgba(34, 197, 94, 0.35)"}`,
    transition: "background 0.12s ease, border-color 0.12s ease",
  };
}

export default function DropOverlays({ preview, targetFrame, emptyFrame, frames, eligible, dragging }: {
  // Превью будущего узла: форма и левый-верхний угол; null — шаблон не тянут.
  preview: { shape: NodeShape; x: number; y: number } | null;
  // Раскрытая рамка под курсором — узел станет ребёнком её контейнера.
  targetFrame: DropFrame | null;
  // Рамка уровня, когда слой пуст.
  emptyFrame: Rect | undefined;
  // Раскрытые рамки уровня (цели броска) — из них красятся принимающие тип.
  frames: readonly DropFrame[];
  // Куда можно бросить тип, который тянут; null — сведений нет (подсветка как до приёмки).
  eligible: DropEligible | null;
  // Плитку тянут (с палитры, курсор может быть ещё не над холстом).
  dragging: boolean;
}) {
  // Тип невозможен на уровне: приглашений уровня нет, зелёным залиты принимающие рамки.
  const levelRefuses = eligible?.levelOk === false;
  const accepts = targetAccepts(eligible, targetFrame);
  const forbidden = !!preview && !accepts;
  const inviteFrames = dragging && eligible && levelRefuses
    ? frames.filter((f) => eligible.frameIds.has(f.id))
    : [];
  const hitFrameId = targetFrame && accepts ? targetFrame.id : null;
  // ПРИГЛАШАЮЩАЯ РАМКА ПУСТОГО СЛОЯ (эпик «связи, упирающиеся в рамку»): пока тянут
  // шаблон, её внутренность светится зелёным — «первый узел кладут сюда»; когда центр
  // будущего узла оказывается внутри, зелёный становится выразительнее.
  // Подсветка ЧИСТО ВИЗУАЛЬНАЯ (canvas.md CV20a): в цели дропа рамка уровня не входит и
  // семантику не меняет — на пустом слое любой дроп и так создаёт ребёнка контейнера,
  // чью рамку видно. Хит-тест — тот же, что у рамок-целей: центр будущего узла в rect.
  const emptyFrameHit = !!emptyFrame && !!preview && !levelRefuses && (() => {
    const cx = preview.x + NODE_W / 2, cy = preview.y + NODE_H / 2;
    const r = emptyFrame;
    return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
  })();

  return (
    <>
      {/* Превью будущего узла: пустая рамка-форма с прозрачным телом — показывает
          точное место создания; над местом, где тип невозможен, — красная (запрет). */}
      {preview && (
        <ViewportPortal>
          <div
            data-drop-preview={forbidden ? "forbidden" : "ok"}
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
            <NodeShapeSvg shape={preview.shape} bg="transparent" stroke={forbidden ? "#ef4444" : "#475569"} outline />
          </div>
        </ViewportPortal>
      )}
      {/* Приглашение пустого слоя: пока тянут шаблон, внутренность рамки родителя
          светится зелёным; когда центр будущего узла внутри — заметнее. */}
      {emptyFrame && preview && !levelRefuses && (
        <ViewportPortal>
          <div
            // стабильный хук для тестов: idle — приглашение, hit — центр узла внутри
            data-empty-frame-hint={emptyFrameHit ? "hit" : "idle"}
            style={inviteStyle(emptyFrame, emptyFrameHit)}
          />
        </ViewportPortal>
      )}
      {/* Рамки-цели типа, невозможного на уровне (CV20c): на всё время драга залиты
          зелёным, рамка под центром будущего узла — заметнее. */}
      {inviteFrames.map((f) => (
        <ViewportPortal key={f.id}>
          <div
            // стабильный хук для тестов: idle — приглашение, hit — центр узла внутри
            data-drop-invite={f.id === hitFrameId ? "hit" : "idle"}
            data-frame-id={f.id}
            style={inviteStyle(f.rect, f.id === hitFrameId)}
          />
        </ViewportPortal>
      ))}
      {/* Индикация цели дропа в раскрытую рамку: подсвечиваем её контур («рамка
          раскрывается шире под новый узел» — узел станет ребёнком её контейнера). Рамка,
          которая тип не принимает, не подсвечивается (превью над ней запретное); когда
          тип невозможен на уровне, цель показывает зелёное приглашение выше. */}
      {targetFrame && accepts && !levelRefuses && (
        <ViewportPortal>
          <div
            data-drop-target={targetFrame.id}
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
