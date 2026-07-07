// Текстовые хелперы графа уровня: перенос подписей и формирование текста связи.

// --- Перенос текста по словам, максимум maxLen символов в строке ---

export function wrapLabel(text: string, maxLen = 20): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
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
  return lines;
}

/** Текст связи: «метка · технология» (для буллетов мастер-стрелки) */
export function edgeText(e: { label: string | null; technology: string | null }): string {
  return [e.label, e.technology].filter(Boolean).join(" · ") || "связь";
}
