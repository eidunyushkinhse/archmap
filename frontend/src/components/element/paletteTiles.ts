// Палитра «Добавить объект» и бросок плитки по месту назначения (приёмка Ф12 2026-10-31,
// раздел 13 docs/plan-c4-elements.md) — чистая модель без разметки. Правило одно: цель
// броска проверяет тип. Плитка активна, если тип возможен на текущем уровне или его
// принимает хотя бы одна раскрытая рамка на холсте; бросок туда, где тип невозможен,
// ничего не создаёт и объясняется словами поля «Тип» (element/typeOptions) — того же
// расчёта, что у окна «Новый объект».
import { TYPE_LABEL, type NodeType } from "../nodeTerms";
import type { DropEligible, DropFrameTarget } from "../graph/types";
import { typeOptions, type TypeOption } from "./typeOptions";

// Плитка палитры: серая (enabled=false) не тянется, reason — подсказка при наведении:
// у серой — почему тип здесь невозможен, у активной только благодаря рамкам — куда его
// положить; у обычной активной подсказки нет (палитра пишет свою).
export interface PaletteTile {
  type: NodeType;
  enabled: boolean;
  reason?: string;
}

// Сколько имён рамок называть в подсказке; остальные — «и ещё N».
const NAMED_FRAMES = 3;

const optionOf = (options: readonly TypeOption[], type: NodeType): TypeOption | undefined =>
  options.find((o) => o.type === type);

// Принимает ли раскрытая рамка тип: её объект — родитель нового объекта.
function frameAccepts(frame: DropFrameTarget, type: NodeType): boolean {
  return optionOf(typeOptions({ mode: "create", parent: frame.subject }), type)?.disabled === false;
}

const framesAccepting = (type: NodeType, frames: readonly DropFrameTarget[]): DropFrameTarget[] =>
  frames.filter((f) => frameAccepts(f, type));

// «orders», «billing», «auth» и ещё 2
function frameNames(frames: readonly DropFrameTarget[]): string {
  const named = frames.slice(0, NAMED_FRAMES).map((f) => `«${f.name}»`).join(", ");
  const rest = frames.length - NAMED_FRAMES;
  return rest > 0 ? `${named} и ещё ${rest}` : named;
}

/**
 * Плитки палитры в порядке типов. levelOptions — варианты поля «Тип» на текущем уровне;
 * null — родитель уровня не загружен: палитра ничего не гасит (тип проверит окно).
 */
export function paletteTiles(
  levelOptions: readonly TypeOption[] | null,
  frames: readonly DropFrameTarget[],
): PaletteTile[] | null {
  if (!levelOptions) return null;
  return levelOptions.map((o) => {
    if (!o.disabled) return { type: o.type, enabled: true };
    const inFrames = framesAccepting(o.type, frames);
    if (inFrames.length > 0) {
      return {
        type: o.type,
        enabled: true,
        reason: `Положите «${TYPE_LABEL[o.type]}» в раскрытую рамку: ${frameNames(inFrames)}`,
      };
    }
    return { type: o.type, enabled: false, reason: o.reason };
  });
}

/**
 * Куда можно бросить тип, который сейчас тянут: на уровень (levelOk) и в какие раскрытые
 * рамки (frameIds). null — драга нет или сведений об уровне нет (окно проверит само).
 */
export function dropEligibility(
  type: NodeType | null,
  levelOptions: readonly TypeOption[] | null,
  frames: readonly DropFrameTarget[],
): DropEligible | null {
  if (!type || !levelOptions) return null;
  return {
    levelOk: optionOf(levelOptions, type)?.disabled === false,
    frameIds: new Set(framesAccepting(type, frames).map((f) => f.id)),
  };
}

/**
 * Почему бросок не создал объект. targetId — раскрытая рамка под курсором (её причина как
 * есть) или null — уровень (его причина и, если есть принимающие рамки, куда положить).
 */
export function dropRefusal(
  type: NodeType,
  targetId: string | null,
  levelOptions: readonly TypeOption[] | null,
  frames: readonly DropFrameTarget[],
): string {
  const fallback = `«${TYPE_LABEL[type]}» здесь создать нельзя.`;
  if (targetId !== null) {
    const frame = frames.find((f) => f.id === targetId);
    const reason = frame && optionOf(typeOptions({ mode: "create", parent: frame.subject }), type)?.reason;
    return reason ?? fallback;
  }
  const reason = (levelOptions && optionOf(levelOptions, type)?.reason) ?? fallback;
  const inFrames = framesAccepting(type, frames);
  return inFrames.length > 0
    ? `${reason} Положите «${TYPE_LABEL[type]}» в раскрытую рамку: ${frameNames(inFrames)}.`
    : reason;
}
