// Раскрытые площадки дерева (SiteTree) — состояние хозяина окна: окно «Размещение»
// задаёт начальное (предки площадок, где стоят выбранные), окно «Площадки» раскрывает
// нового родителя после переноса. Отдельно от компонента — правило react-refresh.
import { useCallback, useState } from "react";

/** Раскрытые площадки окна: переключение по шеврону и раскрытие списком (после
 *  переноса площадки под другого родителя — чтобы она не пропала из виду). */
export function useSiteExpansion(initial?: () => Set<string>) {
  const [expanded, setExpanded] = useState<Set<string>>(initial ?? (() => new Set()));
  const toggle = useCallback((id: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const expand = useCallback((ids: Iterable<string>) => {
    setExpanded((s) => {
      const next = new Set(s);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);
  return { expanded, toggle, expand };
}
