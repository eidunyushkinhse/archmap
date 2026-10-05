// Рамка раскрытого узла под точкой экрана. Интерьер рамки прозрачен для мыши
// (pointerEvents none — выделять и двигать холст сквозь неё, container.md C14), поэтому
// сам клик о рамке не знает: ищем по геометрии среди рамок холста самую вложенную —
// наименьшую из содержащих точку. Узел RF несёт data-id = id узла.
export function frameUnder(root: ParentNode, x: number, y: number): string | null {
  let best: { id: string; area: number } | null = null;
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(".react-flow__node-frame"))) {
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const id = el.dataset.id;
    const area = r.width * r.height;
    if (id && (!best || area < best.area)) best = { id, area };
  }
  return best?.id ?? null;
}
