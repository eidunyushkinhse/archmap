// HTML-шаблоны сайта документации. Внешний вид — как у самого ArchMap (ui/styles.ts,
// pageChrome.ts): светлая тема, slate-нейтрали, синий акцент #2563eb, системный шрифт,
// логотип-знак из ui/icons.tsx. Три колонки: навигация руководства · статья · оглавление.
import { navPath } from "./content.ts";
import { escapeHtml as h } from "./html.ts";
import type { Guide, Heading, NavItem, Page, Site } from "./types.ts";

export const SITE = {
  name: "ArchMap",
  docsTitle: "Документация",
  productUrl: "https://archmap.tech",
  demoUrl: "https://demo.archmap.tech",
  repoUrl: "https://github.com/eidunyushkinhse/archmap",
  releasesUrl: "https://github.com/eidunyushkinhse/archmap/releases",
  editBase: "https://github.com/eidunyushkinhse/archmap/edit/main/docs-site/content/",
};

// Адреса статики с версией в query (кэш браузера сбрасывается при любой правке файла)
export interface Assets {
  css: string;
  hljs: string;
  js: string;
  favicon: string;
  search: string;
}

const LOGO =
  '<span class="logo" aria-hidden="true"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">'
  + '<circle cx="6.5" cy="7" r="2.6" fill="#fff" stroke="none"/><rect x="13" y="13.5" width="6.5" height="6" rx="1.5" fill="#fff" stroke="none"/>'
  + '<path d="M8 8.8 L14.5 14.2" stroke="#bcd2fb"/></svg></span>';

const ICON_SEARCH =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
const ICON_MENU =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const ICON_GITHUB =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.1.79-.25.79-.56v-2.17c-3.2.7-3.87-1.37-3.87-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.8 1.19 1.83 1.19 3.09 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.52 11.52 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z"/></svg>';
const ICON_EDIT =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L18.5 9.5l-4-4L4 16z"/><path d="m13 7 4 4"/></svg>';

// Значки ролей для карточек и шапки навигации (ключ — папка руководства)
const ROLE_ICONS: Record<string, string> = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/>',
  architect: '<circle cx="6.5" cy="7" r="2.6"/><rect x="13" y="13.5" width="6.5" height="6" rx="1.5"/><path d="m8.5 9 4.5 4.5"/><path d="M4 17h5M6.5 14.5v5"/>',
  admin: '<path d="M12 3 4.5 6v5c0 4.5 3.2 8 7.5 10 4.3-2 7.5-5.5 7.5-10V6z"/><path d="m9.5 12 1.8 1.8 3.5-3.6"/>',
};
const ROLE_ICON_DEFAULT = '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 18V5.5M8 7h8M8 11h6"/>';

function roleIcon(key: string): string {
  return `<svg class="role-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ROLE_ICONS[key] ?? ROLE_ICON_DEFAULT}</svg>`;
}

function head(title: string, description: string, a: Assets): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${h(title)}</title>
<meta name="description" content="${h(description)}">
<link rel="icon" type="image/svg+xml" href="${a.favicon}">
<link rel="stylesheet" href="${a.css}">
<link rel="stylesheet" href="${a.hljs}">
</head>`;
}

function header(site: Site, active: Guide | null, withMenu: boolean): string {
  const tabs = site.guides
    .map((g) => `<a class="guide-tab${g === active ? " active" : ""}" href="${g.index.url}"${g === active ? ' aria-current="page"' : ""}>${h(g.short)}</a>`)
    .join("");
  return `<header class="top">
<div class="top-in">
${withMenu ? `<button type="button" class="menu-btn" data-menu aria-label="Открыть навигацию" aria-expanded="false">${ICON_MENU}</button>` : ""}
<a class="brand" href="/">${LOGO}<span class="brand-word">Arch<b>Map</b></span><span class="brand-div"></span><span class="brand-sub">${h(SITE.docsTitle)}</span></a>
<nav class="guides" aria-label="Руководства">${tabs}</nav>
<div class="top-right">
<div class="search" data-search>
<span class="search-ico">${ICON_SEARCH}</span>
<input type="search" placeholder="Поиск по документации" aria-label="Поиск по документации" autocomplete="off" spellcheck="false">
<kbd class="search-kbd" aria-hidden="true">Ctrl K</kbd>
<div class="search-pop" role="listbox" hidden></div>
</div>
<a class="top-link" href="${SITE.productUrl}">archmap.tech</a>
<a class="top-link top-icon" href="${SITE.repoUrl}" aria-label="Репозиторий на GitHub" title="GitHub">${ICON_GITHUB}</a>
</div>
</div>
</header>`;
}

function navList(items: NavItem[], page: Page, depth: number): string {
  let out = "";
  for (const it of items) {
    if (it.kind === "page") {
      const active = it.page === page;
      out += `<a class="side-item${active ? " active" : ""}" href="${it.page.url}"${active ? ' aria-current="page"' : ""}>${h(it.page.title)}</a>`;
    } else {
      const active = it.index === page;
      const title = it.index
        ? `<a class="side-group-title${active ? " active" : ""}" href="${it.index.url}">${h(it.title)}</a>`
        : `<div class="side-group-title">${h(it.title)}</div>`;
      out += `<div class="side-group side-depth-${depth}">${title}${navList(it.items, page, depth + 1)}</div>`;
    }
  }
  return out;
}

function sidebar(site: Site, guide: Guide, page: Page): string {
  const guidesList = site.guides
    .map((g) => `<a class="side-guides-item${g === guide ? " active" : ""}" href="${g.index.url}">${roleIcon(g.key)}<span>${h(g.title)}</span></a>`)
    .join("");
  return `<aside class="side" id="side" aria-label="Навигация по руководству">
<div class="side-guides"><div class="side-guides-title">Руководства</div>${guidesList}</div>
<a class="side-guide${guide.index === page ? " active" : ""}" href="${guide.index.url}">${roleIcon(guide.key)}<span>${h(guide.title)}</span></a>
<nav class="side-nav">${navList(guide.nav, page, 0)}</nav>
</aside>`;
}

function outline(headings: Heading[]): string {
  const items = headings.filter((x) => x.level === 2 || x.level === 3);
  if (items.length < 2) return '<aside class="outline" aria-hidden="true"></aside>';
  const li = items
    .map((x) => `<li class="ol-${x.level}"><a href="#${h(x.id)}" data-outline="${h(x.id)}">${h(x.text)}</a></li>`)
    .join("");
  return `<aside class="outline" aria-label="Содержание страницы"><div class="outline-title">На этой странице</div><ul>${li}</ul></aside>`;
}

function crumbs(parts: { title: string; url: string | null }[]): string {
  const items = parts.map((p, i) => {
    const last = i === parts.length - 1;
    const node = p.url && !last ? `<a href="${p.url}">${h(p.title)}</a>` : `<span${last ? ' aria-current="page"' : ""}>${h(p.title)}</span>`;
    return (i ? '<span class="crumb-sep" aria-hidden="true">›</span>' : "") + node;
  });
  return `<nav class="crumbs" aria-label="Путь">${items.join("")}</nav>`;
}

function pager(prev: Page | null, next: Page | null): string {
  const prevHtml = prev
    ? `<a class="pager-prev" href="${prev.url}" rel="prev"><span class="pager-label">← Назад</span><span class="pager-title">${h(prev.title)}</span></a>`
    : "<span></span>";
  const nextHtml = next
    ? `<a class="pager-next" href="${next.url}" rel="next"><span class="pager-label">Дальше →</span><span class="pager-title">${h(next.title)}</span></a>`
    : "<span></span>";
  return `<nav class="pager" aria-label="Соседние страницы">${prevHtml}${nextHtml}</nav>`;
}

// Карточки разделов на титульной странице руководства — строятся из навигации, руками
// список не ведётся
function guideSections(guide: Guide): string {
  const cards = guide.nav.map((it) => {
    if (it.kind === "page") {
      return `<a class="sec-card" href="${it.page.url}"><span class="sec-title">${h(it.page.title)}</span><span class="sec-desc">${h(it.page.description)}</span></a>`;
    }
    const first = it.index ?? (it.items.find((x) => x.kind === "page") as Extract<NavItem, { kind: "page" }> | undefined)?.page;
    const count = it.items.length;
    const desc = it.index?.description || `${count} ${plural(count, "страница", "страницы", "страниц")}`;
    return first
      ? `<a class="sec-card" href="${first.url}"><span class="sec-title">${h(it.title)}</span><span class="sec-desc">${h(desc)}</span></a>`
      : "";
  });
  if (!cards.length) return "";
  return `<section class="sections"><h2 class="sections-title">Разделы</h2><div class="sec-grid">${cards.join("")}</div></section>`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

function editLink(page: Page): string {
  return `<a class="edit" href="${SITE.editBase}${page.file}" target="_blank" rel="noopener">${ICON_EDIT}Предложить правку</a>`;
}

function footer(): string {
  return `<footer class="foot"><div class="foot-in">
<span>${h(SITE.name)} · ${h(SITE.docsTitle)}</span>
<span class="foot-links"><a href="${SITE.demoUrl}">Демо-стенд</a><a href="${SITE.repoUrl}">GitHub</a><a href="${SITE.releasesUrl}">Выпуски</a></span>
</div></footer>`;
}

function scripts(a: Assets): string {
  return `<script src="${a.js}" defer></script>`;
}

// Страница руководства: навигация · статья · оглавление
export function renderPage(site: Site, guide: Guide, page: Page, prev: Page | null, next: Page | null, a: Assets): string {
  const r = page.render;
  const html = r?.html ?? "";
  const isIndex = guide.index === page;
  const sections = navPath(guide.nav, page);
  const crumbParts: { title: string; url: string | null }[] = [
    { title: SITE.docsTitle, url: "/" },
    { title: guide.title, url: guide.index.url },
    ...sections.map((s) => ({ title: s.title, url: s.index?.url ?? null })),
  ];
  if (!isIndex) crumbParts.push({ title: page.title, url: null });
  const title = isIndex ? `${page.title} · ${SITE.name}` : `${page.title} · ${guide.title} · ${SITE.name}`;
  return `${head(title, page.description, a)}
<body class="docs" data-search-url="${a.search}">
${header(site, guide, true)}
<div class="shell">
${sidebar(site, guide, page)}
<main class="main" id="main">
${crumbs(crumbParts)}
<article class="article">
<h1>${h(page.title)}</h1>
${page.description ? `<p class="lead">${h(page.description)}</p>` : ""}
${html}
${isIndex ? guideSections(guide) : ""}
</article>
<div class="article-foot">
${editLink(page)}
${pager(prev, next)}
</div>
</main>
${outline(r?.headings ?? [])}
</div>
<div class="side-backdrop" data-menu-close></div>
${footer()}
${scripts(a)}
</body>
</html>
`;
}

// Главная: заголовок, вводный текст из index.md и карточки руководств
export function renderHome(site: Site, a: Assets): string {
  const page = site.home;
  const cards = site.guides
    .map(
      (g) => `<a class="guide-card" href="${g.index.url}">
<span class="guide-card-ico">${roleIcon(g.key)}</span>
<span class="guide-card-title">${h(g.title)}</span>
<span class="guide-card-desc">${h(g.description)}</span>
<span class="guide-card-more">Открыть →</span>
</a>`,
    )
    .join("");
  return `${head(`${page.title} · ${SITE.name}`, page.description, a)}
<body class="docs home" data-search-url="${a.search}">
${header(site, null, false)}
<main class="home-main" id="main">
<section class="hero">
<h1>${h(page.title)}</h1>
<div class="hero-text">${page.render?.html ?? ""}</div>
</section>
<section class="guide-cards">${cards}</section>
<section class="home-links">
<a href="${SITE.demoUrl}">Попробовать на демо-стенде</a>
<a href="${SITE.productUrl}">Сайт ArchMap</a>
<a href="${SITE.repoUrl}">Исходный код на GitHub</a>
<a href="${SITE.releasesUrl}">Выпуски</a>
</section>
</main>
${footer()}
${scripts(a)}
</body>
</html>
`;
}

// Корневая страница вне руководств (например, content/changelog.md): шапка и статья без навигации
export function renderStandalone(site: Site, page: Page, a: Assets): string {
  return `${head(`${page.title} · ${SITE.name}`, page.description, a)}
<body class="docs standalone" data-search-url="${a.search}">
${header(site, null, false)}
<main class="main main-solo" id="main">
${crumbs([{ title: SITE.docsTitle, url: "/" }, { title: page.title, url: null }])}
<article class="article">
<h1>${h(page.title)}</h1>
${page.description ? `<p class="lead">${h(page.description)}</p>` : ""}
${page.render?.html ?? ""}
</article>
<div class="article-foot">${editLink(page)}</div>
</main>
${footer()}
${scripts(a)}
</body>
</html>
`;
}

export function renderNotFound(site: Site, a: Assets): string {
  return `${head(`Страница не найдена · ${SITE.name}`, "", a)}
<body class="docs standalone" data-search-url="${a.search}">
${header(site, null, false)}
<main class="main main-solo" id="main">
<article class="article">
<h1>Страница не найдена</h1>
<p class="lead">Такой страницы в документации нет — возможно, она переехала. Начните с <a href="/">главной</a> или воспользуйтесь поиском.</p>
</article>
</main>
${footer()}
${scripts(a)}
</body>
</html>
`;
}
