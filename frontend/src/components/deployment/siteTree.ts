// Дерево площадок для окон «Размещение» и «Площадки»: сервер отдаёт площадки плоским
// списком по имени, дерево строится по parent_id. Обход с seen — данные бывают
// циклическими (правило проекта для обходов предков и потомков).
import type { SiteOut } from "../../types";

export interface SiteNode {
  site: SiteOut;
  // вложенные площадки в порядке списка
  children: SiteNode[];
}

export interface SiteRow {
  site: SiteOut;
  // глубина вложенности (0 — корневая площадка)
  depth: number;
  // есть вложенные площадки (удалить нельзя, пока их не перенесут)
  hasChildren: boolean;
}

/** Площадки деревом: корни с вложенными (порядок списка сохранён); недостижимые от
 *  корней из-за цикла в данных — в конец как корни. */
export function siteForest(sites: readonly SiteOut[]): SiteNode[] {
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
  const seen = new Set<string>();
  const build = (s: SiteOut): SiteNode | null => {
    if (seen.has(s.id)) return null;
    seen.add(s.id);
    const children: SiteNode[] = [];
    for (const c of kids.get(s.id) ?? []) {
      const n = build(c);
      if (n) children.push(n);
    }
    return { site: s, children };
  };
  const out: SiteNode[] = [];
  for (const r of roots) {
    const n = build(r);
    if (n) out.push(n);
  }
  for (const s of sites) {
    if (seen.has(s.id)) continue;
    const n = build(s);
    if (n) out.push(n);
  }
  return out;
}

/** Площадки строками дерева: родитель, затем его вложенные (порядок списка сохранён). */
export function siteRows(sites: readonly SiteOut[]): SiteRow[] {
  const out: SiteRow[] = [];
  const walk = (n: SiteNode, depth: number) => {
    out.push({ site: n.site, depth, hasChildren: n.children.length > 0 });
    for (const c of n.children) walk(c, depth + 1);
  };
  for (const n of siteForest(sites)) walk(n, 0);
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

/** id предков площадки от родителя к корню (без неё самой). */
export function siteAncestorIds(sites: readonly SiteOut[], id: string): string[] {
  const byId = new Map(sites.map((s) => [s.id, s] as const));
  const out: string[] = [];
  const seen = new Set<string>([id]);
  for (let cur = byId.get(id); cur; ) {
    const parent = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    out.push(parent.id);
    cur = parent;
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
