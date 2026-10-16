// Якоря заголовков: слаг из текста (кириллица сохраняется) и уникальность в пределах страницы.

export function slugify(text: string): string {
  const s = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-");
  return s || "section";
}

export class SlugSet {
  readonly used = new Set<string>();

  // Явный якорь {#id}: занять; false — уже занят
  add(id: string): boolean {
    if (this.used.has(id)) return false;
    this.used.add(id);
    return true;
  }

  // Якорь из текста: при повторе — «-2», «-3», …
  take(base: string): string {
    let id = base;
    for (let n = 2; this.used.has(id); n++) id = `${base}-${n}`;
    this.used.add(id);
    return id;
  }
}
