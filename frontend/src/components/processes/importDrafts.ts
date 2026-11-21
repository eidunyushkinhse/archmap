// Черновики импорта процессов из Mermaid (редизайн, фаза 3б): разбор файла на черновики и
// название черновика. Сам Mermaid здесь не разбирается: участников и шаги считает
// только бэкенд (POST /processes/import/preview). Здесь — то, чего бэкенд не делает:
// название из шапки диаграммы, заголовка Markdown или имени файла, и текст без шапки.
//
// Шапку `---\ntitle: …\n---` и строку `title …` внутри диаграммы бэкенд не понимает
// (уходят в «не разобрано»), поэтому в запрос текст идёт без них: название из них уже
// взято.

/** Черновик из файла: текст диаграммы как есть и запасное название. */
export interface DraftSource {
  raw: string;
  // Ближайший заголовок Markdown над блоком или имя файла без расширения.
  fallbackName: string;
}

/** Текст диаграммы без шапки и название из неё (null — названия в тексте нет). */
interface SplitDiagram {
  title: string | null;
  body: string;
}

// Строка `title Оплата` или `title: Оплата` внутри sequenceDiagram. Только с пробелом
// или двоеточием после слова: `title->>B: …` — шаг участника с именем title, его не
// трогаем.
const TITLE_LINE = /^\s*title(?:\s*:\s*|\s+)(.*?)\s*$/i;
const FENCE_LINE = /^\s*---\s*$/;
const FRONT_TITLE = /^\s*title\s*:\s*(.*?)\s*$/i;

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** Название диаграммы и её текст без шапки: из шапки `---\ntitle: …\n---` перед
 *  диаграммой либо из строки `title …` внутри. Обе строки из текста убираются. */
export function splitDiagram(raw: string): SplitDiagram {
  const lines = raw.split(/\r?\n/);
  let title: string | null = null;
  // Шапка (front matter) — только в самом начале, до неё допустимы пустые строки.
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (start < lines.length && FENCE_LINE.test(lines[start])) {
    const end = lines.findIndex((l, i) => i > start && FENCE_LINE.test(l));
    if (end > start) {
      for (const l of lines.slice(start + 1, end)) {
        const m = FRONT_TITLE.exec(l);
        if (m && unquote(m[1])) { title = unquote(m[1]); break; }
      }
      lines.splice(0, end + 1);
    }
  }
  const body: string[] = [];
  for (const l of lines) {
    const m = TITLE_LINE.exec(l);
    if (m) {
      if (title === null && unquote(m[1])) title = unquote(m[1]);
      continue;
    }
    body.push(l);
  }
  return { title, body: body.join("\n").replace(/^\s*\n/, "") };
}

/** Имя файла без расширения: «Оплата заказа.mmd» → «Оплата заказа». */
export function fileStem(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}

function isMarkdown(fileName: string): boolean {
  return /\.(md|markdown)$/i.test(fileName);
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([\w-]*)/;
const SEQUENCE = /^\s*sequenceDiagram\b/m;

/** Черновики файла. В Markdown каждый блок ```mermaid с sequenceDiagram — отдельный
 *  черновик с запасным названием из ближайшего заголовка над ним; любой другой файл —
 *  один черновик целиком. Markdown без таких блоков даёт пустой список. */
export function splitFile(fileName: string, text: string): DraftSource[] {
  const stem = fileStem(fileName);
  if (!isMarkdown(fileName)) return [{ raw: text, fallbackName: stem }];

  const out: DraftSource[] = [];
  const lines = text.split(/\r?\n/);
  let heading: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) {
      const h = HEADING.exec(lines[i]);
      if (h && h[1]) heading = h[1];
      continue;
    }
    // Блок кода: ищем закрывающую черту того же знака не короче открывающей. Заголовки
    // внутри любого блока кода заголовками не считаются.
    const fence = open[1];
    const close = new RegExp(`^\\s*${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    const content = lines.slice(i + 1, j).join("\n");
    if (open[2].toLowerCase() === "mermaid" && SEQUENCE.test(content)) {
      out.push({ raw: content, fallbackName: heading ?? stem });
    }
    i = j;
  }
  // Два блока без своего названия под одним заголовком (или без заголовков) иначе
  // назывались бы одинаково: второй и дальше получают номер.
  const seen = new Map<string, number>();
  return out.map((d) => {
    if (splitDiagram(d.raw).title) return d;
    const n = (seen.get(d.fallbackName) ?? 0) + 1;
    seen.set(d.fallbackName, n);
    return n === 1 ? d : { ...d, fallbackName: `${d.fallbackName} ${n}` };
  });
}

/** Название черновика по умолчанию: шапка диаграммы, иначе запасное. */
export function autoName(source: DraftSource): string {
  return splitDiagram(source.raw).title ?? source.fallbackName;
}
