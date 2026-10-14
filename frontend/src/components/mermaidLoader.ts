// Ленивый синглтон mermaid: один import() и один initialize на всё приложение.
// Отдельный модуль (не в MermaidRenderer.tsx): файл компонента должен экспортировать
// только компоненты (react-refresh), а валидатор нужен и вне рендера — превью
// дозаливки доков проверяет тексты схем без отрисовки.
import type { Mermaid } from "mermaid";
import { lazyOnce } from "../lib/lazyOnce";

// Чанк mermaid не загрузился (после выката старый пропал с сервера, сеть) — это не
// ошибка в тексте схемы, и показывать её как синтаксическую нельзя.
export class MermaidLoadError extends Error {}
export const MERMAID_LOAD_FAILED = "Не удалось загрузить рендерер схем — обновите страницу";

const mermaidOnce = lazyOnce<Mermaid>(() =>
  import("mermaid").then((mod) => {
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
      // Раскладка — ELK layered (с 12.0 дефолт библиотеки, dagre остался за `layout: dagre`);
      // пишем явно, чтобы вид схем не зависел от смены дефолта в следующих версиях.
      layout: "elk",
      // Ширина переноса подписей узла: в 12.0 дефолт упал с 200 до 120 px, и узлы
      // превращались в узкие столбики по 5–7 строк. Держим прежние 200.
      flowchart: { wrappingWidth: 200 },
    });
    return mod.default;
  }),
);

export function loadMermaid(): Promise<Mermaid> {
  return mermaidOnce().catch((err: unknown) => {
    throw new MermaidLoadError(MERMAID_LOAD_FAILED, { cause: err });
  });
}

// Мягкий порог «тяжёлой» схемы (аудит R-16). Жёсткие пределы выше подняты под свои
// данные, но после эпика доступа схему редактора открывает и читатель — у него она
// рендерится на главном потоке минутами. Выше порога рендерер не рисует сам, а
// спрашивает («Показать всё равно»). Порог с запасом выше реальных схем БД на 200
// таблиц; связи считаем по строкам со стрелкой («--», «==», «~~~») — грубо, но дёшево.
export const HEAVY_TEXT = 150_000;
export const HEAVY_EDGES = 1_500;

export function isHeavyChart(chart: string): boolean {
  if (chart.length > HEAVY_TEXT) return true;
  let edges = 0;
  for (const line of chart.split("\n")) {
    if (line.includes("--") || line.includes("==") || line.includes("~~~")) {
      edges += 1;
      if (edges > HEAVY_EDGES) return true;
    }
  }
  return false;
}

// Загружался ли mermaid хоть раз (для статуса «loading» первого рендера).
export function mermaidLoaded(): boolean {
  return mermaidOnce.started();
}

// Валидация текста схемы БЕЗ рендера: null — синтаксис корректен (или проверить не
// удалось: рендерер не загрузился — схема от этого не битая, о выкате скажет плашка
// UpdateNotice), строка — ошибка.
export async function validateMermaid(chart: string): Promise<string | null> {
  let mermaid: Mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return null;
  }
  try {
    await mermaid.parse(chart);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
