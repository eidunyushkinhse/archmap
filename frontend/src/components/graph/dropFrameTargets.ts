// Раскрытые рамки холста как цели броска плитки палитры (приёмка Ф12 2026-10-31, раздел 13
// docs/plan-c4-elements.md): у каждой — объект рамки в том виде, который понимают правила
// поля «Тип» (element/typeOptions). Страница по ним решает, какие плитки активны и куда тип
// можно бросить; сам холст правил типов не знает и лишь сверяется с её ответом
// (targetAccepts). Отдельный модуль, а не useTemplateDrop: хук в тестах холста подменяется.
import type { AncestorRef } from "../../types";
import { parentFrameOf, type FrameRect } from "./layout/frames";
import type { DropEligible, DropFrameTarget } from "./types";
import type { DropFrame } from "./interaction/useTemplateDrop";

/**
 * Принимает ли цель тип: рамка — если она в списке принимающих, уровень — по levelOk.
 * Без сведений принимает любая цель (тип проверит окно «Новый объект»). Один расчёт на
 * бросок (useTemplateDrop) и на подсветку (DropOverlays).
 */
export function targetAccepts(eligible: DropEligible | null | undefined, frame: DropFrame | null): boolean {
  if (!eligible) return true;
  return frame ? eligible.frameIds.has(frame.id) : eligible.levelOk;
}

/**
 * Цели броска из раскрытых рамок уровня (layout.guestFrames: гостевые и локальные). Рамки
 * бывают только у сервиса с вложенными; у раскрытой рамки с действующим «контейнер» этот
 * элемент хранится явно (иначе сервис с вложенными — система). ancestors — крошки уровня
 * (имена и элементы параллельно): по ним называется контейнер составного компонента,
 * если рамки контейнера на холсте нет.
 */
export function dropFrameTargets(
  frames: readonly FrameRect[],
  ancestors: { names: readonly string[]; elements: readonly AncestorRef["element_effective"][] },
): DropFrameTarget[] {
  return frames.map((f) => ({
    id: f.id,
    name: f.name,
    subject: {
      name: f.name,
      shape: "service",
      element: f.element === "container" ? "container" : null,
      element_effective: f.element,
      has_children: true,
      container_name: f.element === "component" ? containerName(f, frames, ancestors) : null,
    },
  }));
}

// Контейнер составного компонента: ближайшая рамка-предок с элементом «контейнер», иначе —
// ближайший такой предок в крошках уровня. Цикла нет: у рамки-предка depth строго меньше.
function containerName(
  frame: FrameRect,
  frames: readonly FrameRect[],
  ancestors: { names: readonly string[]; elements: readonly AncestorRef["element_effective"][] },
): string | null {
  for (let g = parentFrameOf(frames, frame); g; g = parentFrameOf(frames, g)) {
    if (g.element === "container") return g.name;
  }
  for (let i = ancestors.elements.length - 1; i >= 0; i--) {
    if (ancestors.elements[i] === "container") return ancestors.names[i] ?? null;
  }
  return null;
}
