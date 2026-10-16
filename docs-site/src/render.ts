// HTML-шаблоны сайта документации. Внешний вид — как у самого ArchMap (ui/styles.ts,
// pageChrome.ts, NodeTreePanel.css): светлая тема, slate-нейтрали, синий акцент #2563eb,
// системный шрифт, логотип-знак из ui/icons.tsx. Слева — дерево страниц в стиле дерева
// объектов продукта (строки .nt-*), справа — статья. Авторские элементы (кнопки правки)
// в разметке отсутствуют: их добавляет docs.js, когда видит cookie автора.
import { navPath } from "./content.ts";
import { escapeHtml as h } from "./html.ts";
import type { Guide, NavItem, Page, Site } from "./types.ts";

export const SITE = {
  name: "ArchMap",
  docsTitle: "Документация",
  homeLabel: "Домашняя страница",
  productUrl: "https://archmap.tech",
  demoUrl: "https://demo.archmap.tech",
  repoUrl: "https://github.com/eidunyushkinhse/archmap",
};

// Адреса статики с версией в query (кэш браузера сбрасывается при любой правке файла)
export interface Assets {
  css: string;
  hljs: string;
  js: string;
  editorCss: string;
  editorJs: string;
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

// Глифы дерева — те же, что в дереве объектов продукта (nodeTree.shared.tsx):
// контейнер — «коробка с крышкой», лист — прямоугольник; плюс дом для главной.
const GLYPH_ATTRS = 'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"';
const GLYPH_CONTAINER = `<span class="nt-glyph"><svg width="14" height="12" viewBox="0 0 14 12"><rect x="1" y="3.5" width="12" height="7.5" rx="2" ${GLYPH_ATTRS}/><path d="M3.5 3.5 V2 a1 1 0 0 1 1-1 h5 a1 1 0 0 1 1 1 v1.5" ${GLYPH_ATTRS}/></svg></span>`;
const GLYPH_LEAF = `<span class="nt-glyph"><svg width="14" height="12" viewBox="0 0 14 12"><rect x="1.5" y="1.5" width="11" height="9" rx="2" ${GLYPH_ATTRS}/></svg></span>`;
const GLYPH_HOME = `<span class="nt-glyph"><svg width="14" height="12" viewBox="0 0 14 12"><path d="M1.5 6.2 7 1.5l5.5 4.7M3 5v5.5h8V5" ${GLYPH_ATTRS}/></svg></span>`;
const CHEVRON =
  '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6 L15 12 L9 18"/></svg>';

export function head(title: string, description: string, a: Assets, extraCss = ""): string {
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
${extraCss ? `<link rel="stylesheet" href="${extraCss}">` : ""}
</head>`;
}

// Шапка: логотип, «Документация», поиск. Правый край — слот автора (заполняет docs.js).
export function header(withMenu: boolean, withSearch: boolean, subtitle = SITE.docsTitle): string {
  return `<header class="top">
<div class="top-in">
${withMenu ? `<button type="button" class="menu-btn" data-menu aria-label="Открыть дерево страниц" aria-expanded="false">${ICON_MENU}</button>` : ""}
<a class="brand" href="/">${LOGO}<span class="brand-word">Arch<b>Map</b></span><span class="brand-div"></span><span class="brand-sub">${h(subtitle)}</span></a>
<div class="top-right">
${withSearch ? `<div class="search" data-search>
<span class="search-ico">${ICON_SEARCH}</span>
<input type="search" placeholder="Поиск" aria-label="Поиск по документации" autocomplete="off" spellcheck="false">
<kbd class="search-kbd" aria-hidden="true">Ctrl K</kbd>
<div class="search-pop" role="listbox" hidden></div>
</div>` : ""}
<div class="author-slot" data-author-slot></div>
</div>
</div>
</header>`;
}

// ── Дерево страниц (стиль дерева объектов продукта) ──────────────────────────────
function treeRow(opts: { page: Page; label: string; glyph: string; current: boolean; children: string; open: boolean; container: boolean }): string {
  const { page, label, glyph, current, children, open, container } = opts;
  const chev = children
    ? `<button type="button" class="nt-chevzone" data-toggle aria-expanded="${open}" aria-label="${open ? "Свернуть ветку" : "Развернуть ветку"}"><span class="nt-chevhit"><span class="nt-chev">${CHEVRON}</span></span></button>`
    : '<span class="nt-chevspacer"></span>';
  return `<div class="nt-node${open ? " nt-node--open" : ""}" data-file="${h(page.file)}">
<div class="nt-row${current ? " nt-row--current" : ""}">${chev}<a class="nt-link" href="${page.url}"${current ? ' aria-current="page"' : ""}>${glyph}<span class="nt-name${container ? " nt-name--container" : ""}">${h(label)}</span></a></div>
${children ? `<div class="nt-children"${open ? "" : " hidden"}>${children}</div>` : ""}
</div>`;
}

function navTree(items: NavItem[], active: Page | null, openFiles: Set<string>): string {
  return items
    .map((it) => {
      if (it.kind === "page") {
        return treeRow({ page: it.page, label: it.page.title, glyph: GLYPH_LEAF, current: it.page === active, children: "", open: false, container: false });
      }
      const kids = navTree(it.items, active, openFiles);
      if (!it.index) {
        // Раздел без index.md: подпись без ссылки
        return `<div class="nt-node nt-node--open"><div class="nt-row"><span class="nt-chevspacer"></span><span class="nt-link nt-link--plain">${GLYPH_CONTAINER}<span class="nt-name nt-name--container">${h(it.title)}</span></span></div><div class="nt-children">${kids}</div></div>`;
      }
      const open = openFiles.has(it.index.file);
      return treeRow({ page: it.index, label: it.title, glyph: GLYPH_CONTAINER, current: it.index === active, children: kids, open, container: true });
    })
    .join("");
}

// Какие ветки раскрыты в разметке: путь к текущей странице (остальное — по памяти браузера)
function openBranches(site: Site, active: Page | null): Set<string> {
  const open = new Set<string>();
  if (!active) return open;
  const guide = site.guides.find((g) => g.key === active.guide);
  if (!guide) return open;
  open.add(guide.index.file);
  for (const s of navPath(guide.nav, active)) if (s.index) open.add(s.index.file);
  if (active.file.endsWith("/index.md")) open.add(active.file);
  return open;
}

export function treeHtml(site: Site, active: Page | null): string {
  const open = openBranches(site, active);
  const home = treeRow({ page: site.home, label: SITE.homeLabel, glyph: GLYPH_HOME, current: site.home === active, children: "", open: false, container: false });
  const guides = site.guides
    .map((g) => treeRow({ page: g.index, label: g.title, glyph: GLYPH_CONTAINER, current: g.index === active, children: navTree(g.nav, active, open), open: open.has(g.index.file), container: true }))
    .join("");
  const standalone = site.pages
    .filter((p) => p.guide === null && p !== site.home)
    .map((p) => treeRow({ page: p, label: p.title, glyph: GLYPH_LEAF, current: p === active, children: "", open: false, container: false }))
    .join("");
  return `<nav class="tree" aria-label="Страницы документации">${home}${guides}${standalone}</nav>`;
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
  if (!prev && !next) return "";
  const p = prev ? `<a class="pager-prev" href="${prev.url}" rel="prev">← ${h(prev.title)}</a>` : "<span></span>";
  const n = next ? `<a class="pager-next" href="${next.url}" rel="next">${h(next.title)} →</a>` : "<span></span>";
  return `<nav class="pager" aria-label="Соседние страницы">${p}${n}</nav>`;
}

// Список разделов на титульной странице руководства — из навигации, руками не ведётся
function guideSections(guide: Guide): string {
  const items = guide.nav.map((it) => {
    const page = it.kind === "page" ? it.page : it.index ?? (it.items.find((x) => x.kind === "page") as Extract<NavItem, { kind: "page" }> | undefined)?.page;
    if (!page) return "";
    const title = it.kind === "page" ? it.page.title : it.title;
    const desc = it.kind === "page" ? it.page.description : it.index?.description ?? "";
    return `<li><a href="${page.url}">${h(title)}</a>${desc ? `<span class="sec-desc">${h(desc)}</span>` : ""}</li>`;
  });
  if (!items.length) return "";
  return `<section class="sections"><h2 class="sections-title">В этом руководстве</h2><ul class="sec-list">${items.join("")}</ul></section>`;
}

// Список руководств на главной
function homeGuides(site: Site): string {
  const items = site.guides
    .map((g) => `<li><a href="${g.index.url}">${h(g.title)}</a>${g.description ? `<span class="sec-desc">${h(g.description)}</span>` : ""}</li>`)
    .join("");
  return items ? `<section class="sections"><h2 class="sections-title">Руководства</h2><ul class="sec-list">${items}</ul></section>` : "";
}

function footer(): string {
  return `<footer class="foot"><div class="foot-in">
<span>${h(SITE.name)} · ${h(SITE.docsTitle)}</span>
<span class="foot-links"><a href="${SITE.productUrl}">archmap.tech</a><a href="${SITE.demoUrl}">Демо-стенд</a><a href="${SITE.repoUrl}">GitHub</a></span>
</div></footer>`;
}

// Любая страница: дерево слева, статья справа
export function renderPage(site: Site, page: Page, prev: Page | null, next: Page | null, a: Assets): string {
  const r = page.render;
  const guide = site.guides.find((g) => g.key === page.guide) ?? null;
  const isHome = page === site.home;
  const isGuideIndex = guide?.index === page;
  const crumbParts: { title: string; url: string | null }[] = [{ title: SITE.homeLabel, url: "/" }];
  if (guide) {
    crumbParts.push({ title: guide.title, url: guide.index.url });
    for (const s of navPath(guide.nav, page)) crumbParts.push({ title: s.title, url: s.index?.url ?? null });
  }
  if (!isHome && !isGuideIndex) crumbParts.push({ title: page.title, url: null });
  if (isGuideIndex) crumbParts.pop();
  if (isGuideIndex && guide) crumbParts.push({ title: guide.title, url: null });
  const title = isHome ? `${page.title}` : guide && !isGuideIndex ? `${page.title} · ${guide.title} · ${SITE.name}` : `${page.title} · ${SITE.name}`;
  return `${head(title, page.description, a)}
<body class="docs" data-search-url="${a.search}" data-file="${h(page.file)}">
${header(true, true)}
<div class="shell">
<aside class="side" id="side">${treeHtml(site, page)}</aside>
<main class="main" id="main">
${isHome ? "" : crumbs(crumbParts)}
<article class="article">
<h1>${h(page.title)}</h1>
${page.description ? `<p class="lead">${h(page.description)}</p>` : ""}
${r?.html ?? ""}
${isHome ? homeGuides(site) : ""}
${isGuideIndex && guide ? guideSections(guide) : ""}
</article>
${pager(prev, next)}
</main>
</div>
<div class="side-backdrop" data-menu-close></div>
${footer()}
<script src="${a.js}" defer></script>
</body>
</html>
`;
}

export function renderNotFound(site: Site, a: Assets): string {
  return `${head(`Страница не найдена · ${SITE.name}`, "", a)}
<body class="docs" data-search-url="${a.search}">
${header(true, true)}
<div class="shell">
<aside class="side" id="side">${treeHtml(site, null)}</aside>
<main class="main" id="main">
<article class="article">
<h1>Страница не найдена</h1>
<p class="lead">Такой страницы в документации нет — возможно, она переехала. Выберите нужную в дереве слева или воспользуйтесь поиском.</p>
</article>
</main>
</div>
<div class="side-backdrop" data-menu-close></div>
${footer()}
<script src="${a.js}" defer></script>
</body>
</html>
`;
}

// Вход автора. Ссылок на эту страницу нигде нет: адрес /login автор набирает сам.
export function renderLogin(a: Assets, opts: { error: string | null; next: string; configured: boolean }): string {
  const body = opts.configured
    ? `<form method="post" action="/login" class="login-form">
<input type="hidden" name="next" value="${h(opts.next)}">
<label for="pw">Пароль автора</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
${opts.error ? `<p class="login-error">${h(opts.error)}</p>` : ""}
<button type="submit" class="btn-primary">Войти</button>
</form>`
    : `<p class="login-error">Вход не настроен: задайте пароль автора командой <code>npm run password</code> (или переменной DOCS_AUTHOR_PASSWORD) и перезапустите сервер.</p>`;
  return `${head(`Вход автора · ${SITE.name}`, "", a)}
<body class="docs login-page">
${header(false, false, "Вход автора")}
<main class="login-main">
<div class="login-card">
<h1>Вход для автора</h1>
<p class="login-hint">Читателям вход не нужен: документация открыта. Войдя, вы сможете править страницы прямо в браузере.</p>
${body}
</div>
</main>
</body>
</html>
`;
}

// Редактор автора: каркас, содержимое грузит editor.js через API
export function renderEditor(a: Assets): string {
  return `${head(`Редактор · ${SITE.docsTitle} · ${SITE.name}`, "", a, a.editorCss)}
<body class="docs editor-page">
${header(false, false, "Редактор")}
<div class="ed" id="ed">
<aside class="ed-side">
<div class="ed-side-actions">
<button type="button" class="btn-soft" data-new="page">+ Страница</button>
<button type="button" class="btn-soft" data-new="fragment">+ Фрагмент</button>
</div>
<div class="ed-tree" data-tree></div>
</aside>
<main class="ed-main" data-main>
<div class="ed-empty" data-empty><p>Выберите страницу в дереве слева или создайте новую.</p></div>
<form class="ed-form" data-form hidden>
<div class="ed-fields">
<input class="ed-title" name="title" placeholder="Название страницы" autocomplete="off" required>
<input class="ed-desc" name="description" placeholder="Описание одной фразой — подзаголовок страницы и текст в поиске" autocomplete="off">
<div class="ed-fields-row">
<label>Порядок <input name="order" type="number" min="0" step="1" class="ed-order"></label>
<label data-short-wrap hidden>Короткое имя <input name="short" class="ed-short" autocomplete="off"></label>
<span class="ed-file" data-file-label></span>
</div>
</div>
<div class="ed-toolbar">
<select class="ed-insert" data-insert-fragment><option value="">Вставить фрагмент…</option></select>
<select class="ed-insert" data-insert-link><option value="">Ссылка на страницу…</option></select>
<select class="ed-insert" data-insert-block>
<option value="">Блок…</option>
<option value="note">Примечание</option>
<option value="tip">Совет</option>
<option value="warning">Внимание</option>
<option value="danger">Осторожно</option>
<option value="details">Свёрнутый блок</option>
</select>
<label class="btn-soft ed-upload">Картинка<input type="file" accept="image/*" data-upload hidden></label>
<span class="ed-grow"></span>
<span class="ed-views" role="group" aria-label="Вид">
<button type="button" class="ed-view-btn" data-view="source" aria-pressed="false">Текст</button>
<button type="button" class="ed-view-btn" data-view="split" aria-pressed="true">Текст + просмотр</button>
<button type="button" class="ed-view-btn" data-view="preview" aria-pressed="false">Просмотр</button>
</span>
</div>
<div class="ed-panes" data-panes>
<textarea class="ed-source" name="body" spellcheck="true" data-source></textarea>
<div class="ed-preview"><article class="article" data-preview></article></div>
</div>
<div class="ed-bottom">
<button type="submit" class="btn-primary" data-save>Сохранить</button>
<span class="ed-status" data-status></span>
<span class="ed-grow"></span>
<a class="ed-link" data-open target="_blank" rel="noopener">Открыть страницу ↗</a>
<button type="button" class="btn-danger" data-delete>Удалить</button>
</div>
<div class="ed-problems" data-problems hidden></div>
<div class="ed-usage" data-usage hidden></div>
</form>
</main>
</div>
<dialog class="ed-dialog" data-new-dialog>
<form method="dialog" class="ed-dialog-form" data-new-form>
<h2 data-new-title>Новая страница</h2>
<label>Где <select name="parent" data-new-parent></select></label>
<label>Название <input name="title" autocomplete="off" required></label>
<label>Адрес (латиницей) <input name="slug" pattern="[a-z0-9-]+" autocomplete="off" required></label>
<label data-new-kind-wrap><input type="checkbox" name="section"> Раздел с подстраницами (папка с index.md)</label>
<p class="login-error" data-new-error hidden></p>
<div class="ed-dialog-actions">
<button type="submit" class="btn-primary" value="create">Создать</button>
<button type="button" class="btn-soft" value="cancel" data-new-cancel>Отмена</button>
</div>
</form>
</dialog>
<script src="${a.js}" defer></script>
<script src="${a.editorJs}" defer></script>
</body>
</html>
`;
}
