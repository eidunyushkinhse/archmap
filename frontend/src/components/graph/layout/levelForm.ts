// Выбор ФОРМЫ авто-раскладки уровня по топологии сцены (перф-эпик Ф4, спека
// node.md N30). Правило v2 выведено из Δ-замеров 12 сцен и раунда скептика
// (docs/review-layout-rule.md → *-qwen.md → *-response.md): чистые звёзды и
// сцены с доминантным хабом на force красивее И дешевле для роутера; потоки
// и плотные мультихабы — на layered (force там ×2.9–3.3 дороже и визуально
// хуже). Метрика — undirected-свёртка направленных мастер-рёбер layoutLevel
// (боевая семантика; обзор по живым проектам — scripts/hub-survey.py).

export type LevelForm = "layered" | "force";

// Константы правила (N30). Порог доли хаба выбран по Δ-цене роутера, а не по
// середине зазора распределения: в force-зоне нет ни одной сцены, где роутер
// подорожал (обзор 2026-08-20: звёзды h1u ≥ 0.75, потоки/мультихабы ≤ 0.71).
export const STAR_DIAMETER_MAX = 2;      // диаметр ≤ 2 — чистая звезда (все корни)
export const STAR_HUB_SHARE = 0.75;      // доля рёбер, инцидентных хабу
export const FORM_MIN_EDGES = 5;         // меньше — форма неразличима, метрика шумит
export const FORM_MIN_HUB_NEIGHBORS = 3; // дегенераты (цепочка, цикл C5) не звездятся

/** Форма уровня: force для звёздной топологии, layered для потоковой. */
export function pickLevelForm(
  edges: ReadonlyArray<{ source_id: string; target_id: string }>,
): LevelForm {
  // undirected-свёртка: встречная пара мастер-рёбер — одна «спица», не две
  const und = new Set<string>();
  for (const e of edges) {
    if (e.source_id === e.target_id) continue; // петли форму не задают
    und.add(
      e.source_id < e.target_id
        ? `${e.source_id}|${e.target_id}`
        : `${e.target_id}|${e.source_id}`,
    );
  }
  const E = und.size;
  if (E < FORM_MIN_EDGES) return "layered";
  const adj = new Map<string, Set<string>>();
  for (const key of und) {
    const [a, b] = key.split("|");
    let sa = adj.get(a);
    if (!sa) { sa = new Set(); adj.set(a, sa); }
    sa.add(b);
    let sb = adj.get(b);
    if (!sb) { sb = new Set(); adj.set(b, sb); }
    sb.add(a);
  }
  let hubDeg = 0;
  for (const s of adj.values()) hubDeg = Math.max(hubDeg, s.size);
  if (hubDeg < FORM_MIN_HUB_NEIGHBORS) return "layered";
  if (hubDeg / E >= STAR_HUB_SHARE) return "force";
  // Диаметр: BFS из каждой вершины (сцены ≤ ~100 узлов — дёшево). Несвязный
  // граф — максимум по компонентам (force сам пакует компоненты,
  // separateConnectedComponents у него включён по умолчанию).
  let diam = 0;
  for (const start of adj.keys()) {
    const dist = new Map<string, number>([[start, 0]]);
    const q = [start];
    for (let qi = 0; qi < q.length; qi++) {
      const cur = q[qi];
      const curD = dist.get(cur) ?? 0;
      for (const nb of adj.get(cur) ?? []) {
        if (!dist.has(nb)) { dist.set(nb, curD + 1); q.push(nb); }
      }
    }
    for (const d of dist.values()) diam = Math.max(diam, d);
    if (diam > STAR_DIAMETER_MAX) return "layered"; // ранний выход: уже не звезда
  }
  return "force";
}
