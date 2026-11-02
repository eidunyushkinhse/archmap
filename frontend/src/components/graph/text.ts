// Текстовые хелперы графа уровня: перенос подписей и формирование текста связи.

// --- Перенос текста по словам, максимум maxLen символов в строке ---

export function wrapLabel(text: string, maxLen = 20): string[] {
  // явные переносы автора (многострочное описание связи) режут первыми; пустые
  // строки схлопываются (двойной \n не раздувает плашку вертикальным зазором)
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    const words = para.split(" ").filter(Boolean);
    let current = "";
    for (const word of words) {
      if (!current) {
        current = word;
      } else if ((current + " " + word).length <= maxLen) {
        current += " " + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

/** Текст связи: «метка · технология» (для буллетов мастер-стрелки) */
export function edgeText(e: { label: string | null; technology: string | null }): string {
  return [e.label, e.technology].filter(Boolean).join(" · ") || "связь";
}

/** Пункты плашки мастер-стрелки: РАЗЛИЧНЫЕ тексты членов в порядке первого появления.
 *  Десять связей «пользуется» на одной шине — один пункт, а не десять одинаковых буллетов
 *  (edge.md E2). Единый источник для оценки габаритов (edgeLabelMeta) и рендера (assembleRf):
 *  плашка и её место в раскладке считаются по одному и тому же списку. */
export function distinctEdgeTexts(members: ReadonlyArray<{ label: string | null; technology: string | null }>): string[] {
  return [...new Set(members.map(edgeText))];
}
