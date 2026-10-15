import { useEffect, useState } from "react";
import { nodesApi } from "../api/nodes";
import type { Node } from "../types";

// Поиск узлов по имени с дебаунсом (аудит F-52): одна реализация для дерева объектов и
// выбора конца связи. Ответ устаревшего запроса не применяется (F-53): набрали дальше —
// прежний поиск, ответивший позже свежего, не перетрёт результаты. found — итог
// ПОСЛЕДНЕГО непустого запроса; показывать ли его, решает вызывающий по своему query
// (гашение на пустой строке эффектом было бы синхронным setState внутри эффекта).
export function useNodeSearch(query: string, delayMs: number): {
  found: Node[] | null;
  searching: boolean;
  // Забыть найденное (выбор сделан — прежний список не должен всплыть на новом наборе).
  reset: () => void;
} {
  const q = query.trim();
  const [found, setFound] = useState<Node[] | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    if (!q) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      setSearching(true);
      nodesApi.search(q)
        .then((ns) => { if (alive) setFound(ns); })
        .catch(() => { if (alive) setFound([]); })
        .finally(() => { if (alive) setSearching(false); });
    }, delayMs);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [q, delayMs]);
  return { found, searching, reset: () => setFound(null) };
}
