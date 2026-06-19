import type { ProjectPreview } from "../../types";

/**
 * Раскладка узлов превью в координатах холста. Координаты сохраняются в БД только
 * при ручном перетаскивании, поэтому часть корней приходит без позиции (их на
 * холсте кладёт ELK). Чтобы превью всё равно отражало реальное расположение:
 * - узлы с сохранёнными координатами берём как есть;
 * - узел без координат ставим в ЦЕНТРОИД связанных уже-размещённых соседей (узел в
 *   ряду попадает между своими соседями — как на холсте), за несколько проходов;
 * - если размещённых координат нет вообще (схему не раскладывали) — окружность.
 */
export function resolvePoints(
  raw: ProjectPreview["nodes"],
  edges: ProjectPreview["edges"],
): { x: number; y: number }[] {
  const placed = new Map<string, { x: number; y: number }>();
  for (const n of raw) {
    if (n.x !== null && n.y !== null) placed.set(n.id, { x: n.x, y: n.y });
  }

  // Схему ни разу не раскладывали вручную → декоративная окружность.
  if (placed.size === 0) {
    return raw.map((_, i) => {
      if (raw.length === 1) return { x: 0, y: 0 };
      const a = (i / raw.length) * Math.PI * 2 - Math.PI / 2;
      return { x: Math.cos(a), y: Math.sin(a) };
    });
  }

  // Соседи по связям (ненаправленно).
  const neighbors = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    const arr = neighbors.get(a);
    if (arr) arr.push(b);
    else neighbors.set(a, [b]);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }

  // Проходами доставляем позиции узлам без координат — по центроиду размещённых
  // соседей (новые размещения участвуют в следующих проходах: цепочки тоже доедут).
  let pending = raw.filter((n) => !placed.has(n.id)).map((n) => n.id);
  while (pending.length > 0) {
    const still: string[] = [];
    let progressed = false;
    for (const id of pending) {
      const ns = (neighbors.get(id) ?? []).map((nb) => placed.get(nb)).filter((p) => p != null);
      if (ns.length > 0) {
        const cx = ns.reduce((s, p) => s + p.x, 0) / ns.length;
        const cy = ns.reduce((s, p) => s + p.y, 0) / ns.length;
        placed.set(id, { x: cx, y: cy });
        progressed = true;
      } else {
        still.push(id);
      }
    }
    if (!progressed) break; // оставшиеся ни с кем размещённым не связаны
    pending = still;
  }

  // Изолированные узлы без связей с размещёнными — кольцом вокруг центра масс.
  if (pending.length > 0) {
    let sx = 0;
    let sy = 0;
    for (const p of placed.values()) {
      sx += p.x;
      sy += p.y;
    }
    const cx = sx / placed.size;
    const cy = sy / placed.size;
    pending.forEach((id, i) => {
      const a = (i / pending.length) * Math.PI * 2;
      placed.set(id, { x: cx + Math.cos(a) * 180, y: cy + Math.sin(a) * 180 });
    });
  }

  return raw.map((n) => placed.get(n.id) ?? { x: 0, y: 0 });
}
