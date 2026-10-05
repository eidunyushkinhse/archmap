// Маршрут глазами тура: разбор хэша теми же правилами, что у роутера App
// (#/projects, #/p/<id>, #/p/<id>/nodes/<nodeId>, #/p/<id>/map/<levelId?>). Слой
// редактора хэш знает только при открытии: дальше уровни меняются внутри страницы, и
// о них тур узнаёт событием шины «level» (tourBus.ts).

export type TourRoute =
  | { name: "projects" }
  | { name: "other" }
  | { name: "project-home"; projectId: string }
  | { name: "node"; projectId: string; nodeId: string }
  | { name: "map"; projectId: string };

const ID = "[0-9a-fA-F-]+";

export function parseTourRoute(rawHash: string): TourRoute {
  const hash = rawHash.replace(/^#/, "");
  if (/^\/admin\//.test(hash)) return { name: "other" };
  const map = hash.match(new RegExp(`^/p/(${ID})/map(?:[/?]|$)`));
  if (map) return { name: "map", projectId: map[1] };
  const node = hash.match(new RegExp(`^/p/(${ID})/nodes/(${ID})`));
  if (node) return { name: "node", projectId: node[1], nodeId: node[2] };
  const home = hash.match(new RegExp(`^/p/(${ID})`));
  if (home) return { name: "project-home", projectId: home[1] };
  return { name: "projects" };
}

/** Проект маршрута или null (список проектов, прочие экраны). */
export function routeProject(route: TourRoute): string | null {
  return "projectId" in route ? route.projectId : null;
}
