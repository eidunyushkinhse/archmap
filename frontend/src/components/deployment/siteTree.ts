// Дерево площадок для окон «Размещение» и «Площадки»: сервер отдаёт площадки плоским
// списком по имени, дерево строится по parent_id. Обход с seen — данные бывают
// циклическими (правило проекта для обходов предков и потомков).
import type { SiteOut } from "../../types";

export interface SiteRow {
  site: SiteOut;
  // глубина вложенности (0 — корневая площадка)
  depth: number;
  // есть вложенные площадки (удалить нельзя, пока их не перенесут)
  hasChildren: boolean;
}

/** Площадки строками дерева: родитель, затем его вложенные (порядок списка сохранён). */
export function siteRows(sites: readonly SiteOut[]): SiteRow[] {
  const ids = new Set(sites.map((s) => s.id));
  const kids = new Map<string, SiteOut[]>();
  const roots: SiteOut[] = [];
  for (const s of sites) {
    if (s.parent_id && ids.has(s.parent_id) && s.parent_id !== s.id) {
      const list = kids.get(s.parent_id);
      if (list) list.push(s);
      else kids.set(s.parent_id, [s]);
    } else {
      roots.push(s);
    }
  }
  const out: SiteRow[] = [];
  const seen = new Set<string>();
  const walk = (s: SiteOut, depth: number) => {
    if (seen.has(s.id)) return;
    seen.add(s.id);
    const children = kids.get(s.id) ?? [];
    out.push({ site: s, depth, hasChildren: children.length > 0 });
    for (const c of children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // площадки, недостижимые от корней (цикл в данных), — в конец плоско
  for (const s of sites) if (!seen.has(s.id)) walk(s, 0);
  return out;
}

/** id площадки и всех её вложенных: в родители ей их ставить нельзя (цикл). */
export function siteSubtree(sites: readonly SiteOut[], rootId: string): Set<string> {
  const out = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const s of sites) {
      if (s.parent_id && out.has(s.parent_id) && !out.has(s.id)) {
        out.add(s.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Путь площадки именами от корня: «Облако / Кластер prod». */
export function sitePath(sites: readonly SiteOut[], id: string): string {
  const byId = new Map(sites.map((s) => [s.id, s] as const));
  const names: string[] = [];
  const seen = new Set<string>();
  for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = cur.parent_id ? byId.get(cur.parent_id) : undefined) {
    seen.add(cur.id);
    names.unshift(cur.name);
  }
  return names.join(" / ");
}
