// Крайние слои ELK для гостей (Ф4б эпика «стрелки без жёстких хэндлов», шаг 1;
// docs/plan-arrows-ports.md).
//
// Плоский ELK уровня видит гостей обычными узлами и даёт им слои ВНУТРИ потока локалов:
// гость-источник, связанный с узлом третьего ряда, встаёт во второй ряд, под него
// раздвигаются соседи, а кольцо потом уносит его на периметр — локалы остаются с дырами,
// сцена разъезжается (полигон: система 16.5k px линий против 11k у эталона). У вложенных
// коробок ELK (compound) гость стоит ЗА первым/последним рядом локалов. Ровно это и
// воспроизводим ограничением слоя ELK (`layerConstraint`): источники — отдельный слой
// ПЕРЕД первым рядом локалов (FIRST_SEPARATE), приёмники — ПОСЛЕ последнего
// (LAST_SEPARATE); пересечения длинной стрелки гостя через ряды ELK учитывает сам
// (крайние слои участвуют в минимизации пересечений и расстановке по оси ряда).
//
// Почему не партиции ELK (`elk.partitioning`): их фиктивные рёбра «каждый с каждым»
// между соседними партициями тянут КАЖДОГО локала к обеим крайним партициям, и при
// неравном числе гостей сверху и снизу локальные стоки/истоки уезжают к большей
// (зонд elkjs 0.11.1: сток от первого ряда падал в последний; priority.shortness не
// спасает). Отдельный слой на локалов не влияет вовсе. Цена: ELK не принимает связь
// гость→гость внутри одного крайнего слоя («has at least one incoming edge») — такие
// связи во вход ELK не отдаются (layoutLevel), их рисует роутер; связь источник→приёмник
// через всю схему ELK принимает. Встречные связи гость↔локал принимаются как есть.
//
// Сторона гостя — по связям со «стороной уровня»: локалы и рамки-концы (контейнер
// уровня, поглощённые раскрытием локалы). Группа гостевой рамки (раскрытый гостевой
// контейнер) решается ЦЕЛИКОМ — её члены едут жёсткой группой (guest.md G16). Паритет с
// cycle breaking ELK: большинство направлений; ничья — пользователь (shape person)
// наверх, прочие внешние системы вниз (их зовут — они под схемой, как принято в C4).
// Гость без связей со стороной уровня наследует сторону соседа-гостя (связан только с
// источником — сам источник); совсем без соседей — приёмник.
import type { DisplayExternal } from "../types";
import type { AncestorRef } from "../../../types";

/** Крайний слой гостя: "first" — перед первым рядом локалов, "last" — за последним. */
export type GuestLayer = "first" | "last";

/**
 * Крайний слой каждой отображаемой внешней сущности. Локалы в карту не входят.
 */
export function guestLayerSides(params: {
  entities: readonly DisplayExternal[];
  /** отображаемые локалы — «сторона уровня» */
  localIds: ReadonlySet<string>;
  /** рамки-концы (контейнер уровня, поглощённые раскрытием локалы) — тоже сторона уровня */
  frameEndIds: ReadonlySet<string>;
  /** мастер-рёбра отображаемой сцены, включая связи в рамки */
  groups: ReadonlyArray<{ source: string; target: string }>;
  ancestorIds: readonly string[];
}): Map<string, GuestLayer> {
  const { entities, localIds, frameEndIds, groups, ancestorIds } = params;
  const result = new Map<string, GuestLayer>();
  if (entities.length === 0) return result;

  // Ключ группы — самый внешний гостевой контейнер-предок ниже общего предка с уровнем
  // (его раскрытие обнажило сущность) либо сама сущность. Тот же ключ, что у колец
  // (ringPlacement: гостевая рамка минимальной глубины, содержащая гостя).
  const bcIndex = new Map(ancestorIds.map((id, i) => [id, i]));
  const entAncestors = (e: DisplayExternal): AncestorRef[] =>
    e.kind === "leaf" ? (e.ghost.ancestors ?? []) : e.ancestors;
  const groupOf = new Map<string, string>();
  const personGroups = new Set<string>();
  for (const e of entities) {
    const anc = entAncestors(e);
    let lcaPos = -1;
    anc.forEach((x, pos) => { if (bcIndex.has(x.id) && pos > lcaPos) lcaPos = pos; });
    const key = lcaPos + 1 < anc.length ? anc[lcaPos + 1].id : e.id;
    groupOf.set(e.id, key);
    if (e.kind === "leaf" && e.ghost.shape === "person") personGroups.add(key);
  }
  const isLevelSide = (id: string): boolean => localIds.has(id) || frameEndIds.has(id);

  // Счёт направлений связей группы со стороной уровня
  const tally = new Map<string, { outs: number; ins: number }>();
  const bump = (key: string, dir: "outs" | "ins"): void => {
    const t = tally.get(key) ?? { outs: 0, ins: 0 };
    t[dir]++;
    tally.set(key, t);
  };
  for (const g of groups) {
    const gs = groupOf.get(g.source), gt = groupOf.get(g.target);
    if (gs !== undefined && gt === undefined && isLevelSide(g.target)) bump(gs, "outs");
    else if (gt !== undefined && gs === undefined && isLevelSide(g.source)) bump(gt, "ins");
  }
  const decided = new Map<string, GuestLayer>();
  for (const [key, t] of tally) {
    decided.set(key, t.outs > t.ins ? "first"
      : t.ins > t.outs ? "last"
        : personGroups.has(key) ? "first" : "last");
  }

  // Группы без связей со стороной уровня — по соседям-гостям, волнами (цепочки гостей):
  // большинство сторон решённых соседей, ничья — приёмник. Направление связи сторону не
  // меняет: сосед источника стоит в слое источников (связь между ними рисует роутер).
  const allKeys = new Set(groupOf.values());
  let progress = true;
  while (progress) {
    progress = false;
    const votes = new Map<string, { first: number; last: number }>();
    for (const g of groups) {
      const gs = groupOf.get(g.source), gt = groupOf.get(g.target);
      if (gs === undefined || gt === undefined || gs === gt) continue;
      for (const [me, other] of [[gs, gt], [gt, gs]] as const) {
        if (decided.has(me)) continue;
        const p = decided.get(other);
        if (p === undefined) continue;
        const v = votes.get(me) ?? { first: 0, last: 0 };
        v[p]++;
        votes.set(me, v);
      }
    }
    for (const [key, v] of votes) {
      decided.set(key, v.first > v.last ? "first" : "last");
      progress = true;
    }
  }
  for (const key of allKeys) if (!decided.has(key)) decided.set(key, "last");

  for (const e of entities) {
    const key = groupOf.get(e.id);
    // groupOf заполнен для всех entities; ?? — страховка типов
    result.set(e.id, decided.get(key ?? e.id) ?? "last");
  }
  return result;
}
