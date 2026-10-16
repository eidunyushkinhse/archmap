// Фронтматтер страницы: блок «---» в начале файла со строками «ключ: значение».
// Намеренно без YAML-парсера: нужны только плоские значения (строка, число, булево).
import type { FrontMatter, FrontMatterValue } from "./types.ts";

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontMatter(src: string): { fm: FrontMatter; body: string } {
  const m = FM_RE.exec(src);
  if (!m) return { fm: {}, body: src };
  const fm: FrontMatter = {};
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf(":");
    if (i <= 0) throw new Error(`фронтматтер: строка не вида «ключ: значение» — «${rawLine}»`);
    fm[line.slice(0, i).trim()] = parseValue(line.slice(i + 1).trim());
  }
  return { fm, body: src.slice(m[0].length) };
}

function parseValue(v: string): FrontMatterValue {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export function fmString(fm: FrontMatter, key: string): string | null {
  const v = fm[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

export function fmNumber(fm: FrontMatter, key: string): number | null {
  const v = fm[key];
  return typeof v === "number" ? v : null;
}
