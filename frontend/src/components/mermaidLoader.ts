// Ленивый синглтон mermaid: один import() и один initialize на всё приложение.
// Отдельный модуль (не в MermaidRenderer.tsx): файл компонента должен экспортировать
// только компоненты (react-refresh), а валидатор нужен и вне рендера — превью
// дозаливки доков проверяет тексты схем без отрисовки.
import type { Mermaid } from "mermaid";

let mermaidP: Promise<Mermaid> | null = null;

export function loadMermaid(): Promise<Mermaid> {
  mermaidP ??= import("mermaid").then((mod) => {
    mod.default.initialize({
      startOnLoad: false,
      theme: "neutral",
      securityLevel: "strict",
      // Лимиты подняты против дефолтов (50К символов / 500 рёбер): те задуманы как
      // защита от ЧУЖОГО ввода на публичных площадках, а у нас ввод — собственные
      // данные пользователя. На схеме БД в 203 таблицы дефолт отдавал вместо ER
      // картинку «Maximum text size in diagram exceeded»; полноэкранный пан/зум для
      // больших диаграмм уже есть.
      maxTextSize: 1_000_000,
      maxEdges: 4_000,
    });
    return mod.default;
  });
  return mermaidP;
}

// Загружался ли mermaid хоть раз (для статуса «loading» первого рендера).
export function mermaidLoaded(): boolean {
  return mermaidP !== null;
}

// Валидация текста схемы БЕЗ рендера: null — синтаксис корректен, строка — ошибка.
export async function validateMermaid(chart: string): Promise<string | null> {
  try {
    const mermaid = await loadMermaid();
    await mermaid.parse(chart);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
