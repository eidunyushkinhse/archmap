// Типы содержимого документации: страницы, руководства, навигация, ссылки.

export type FrontMatterValue = string | number | boolean;
export type FrontMatter = Record<string, FrontMatterValue>;

// Заголовок страницы (после рендера): уровень, якорь и текст — для оглавления и проверки ссылок
export interface Heading {
  level: number;
  id: string;
  text: string;
}

// Кусок страницы для поискового индекса: один заголовок h2/h3 — одна запись
export interface SearchSection {
  heading: string;
  id: string;
  text: string;
}

// Ссылка на другую страницу (или якорь): проверяется после рендера всех страниц
export interface LinkRef {
  page: string;   // страница, на которой ссылка окажется
  from: string;   // файл, в котором она написана (страница или фрагмент)
  target: string; // путь целевой страницы от корня content
  hash: string;   // якорь без «#» («» — без якоря)
  raw: string;    // как написано в Markdown — для сообщений об ошибках
}

// Картинка или файл по относительному пути: должен существовать, копируется в сборку
export interface AssetRef {
  from: string;
  target: string;
  raw: string;
}

export interface RenderResult {
  html: string;
  headings: Heading[];
  sections: SearchSection[];
  links: LinkRef[];
  assets: AssetRef[];
  includes: string[]; // фрагменты, включённые в страницу (карта «единого источника истины»)
}

export interface Page {
  file: string;         // путь от корня content, posix: «user/navigation.md»
  url: string;          // «/user/navigation/»
  title: string;
  description: string;
  order: number;
  fm: FrontMatter;
  guide: string | null; // ключ руководства (папка верхнего уровня) или null у корневых страниц
  body: string;         // Markdown без фронтматтера
  render: RenderResult | null;
}

export type NavItem =
  | { kind: "page"; page: Page }
  | { kind: "section"; title: string; order: number; index: Page | null; items: NavItem[] };

export interface Guide {
  key: string;
  title: string;
  short: string;        // короткое имя для переключателя в шапке
  description: string;
  order: number;
  index: Page;
  nav: NavItem[];
  flat: Page[];         // титульная страница и все страницы в порядке навигации (prev/next)
}

export interface Site {
  home: Page;
  guides: Guide[];
  pages: Page[];
  byFile: Map<string, Page>;
}
