import type { CSSProperties } from "react";

/**
 * Строки блока кода окна «Токен выпущен» (IssuedTokenView): длинная строка переносится
 * только по пробелам между словами, а её продолжение стоит с висячим отступом на 2 знака
 * глубже отступа самой строки. Доработка находки 8 (2026-11-24): перенос по знакам рвал
 * ключ --header после дефиса, а продолжение у левого края в YAML читалось новой строкой.
 *
 * Разметка (стили в userDialogs.css): строка исходного текста — блок ud-line, число её
 * ведущих пробелов — переменная --ud-indent, от неё стили считают отступ продолжения;
 * слово (цепочка знаков без пробелов) — строчный блок ud-word: целиком переезжает на
 * следующую экранную строку, а слово длиннее блока рвётся по его краю. Ведущие пробелы и
 * пробелы между словами — обычный текст. Перевод строки — знак «\n» в конце строки-блока:
 * так и textContent, и текст выделения в Chrome равны исходному знак в знак (перевод
 * между блоками дал бы пустые экранные строки, а без него пропал бы из textContent).
 */
interface Props {
  text: string;
  /** Первое слово текста, которое рисуется тихим цветом (заглушка имени программы). */
  stub?: string;
}

export default function CodeLines({ text, stub }: Props) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const indent = /^ */.exec(line)?.[0].length ?? 0;
        // Слова и пробелы между ними по очереди; пустые куски по краям split отбрасываем.
        const parts = line.slice(indent).split(/( +)/).filter((p) => p !== "");
        return (
          <span key={i} className="ud-line" style={{ "--ud-indent": indent } as CSSProperties}>
            {indent > 0 ? line.slice(0, indent) : null}
            {parts.map((p, j) =>
              p.startsWith(" ") ? p : (
                <span key={j} className={i === 0 && indent === 0 && j === 0 && p === stub ? "ud-word ud-stub" : "ud-word"}>
                  {p}
                </span>
              ),
            )}
            {i < lines.length - 1 ? "\n" : null}
          </span>
        );
      })}
    </>
  );
}
