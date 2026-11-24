// Превью черновиков импорта процессов (редизайн, фаза 3б): считается само, без кнопки
// «Разобрать». Через PREVIEW_DELAY после правки текста или выбора участника уходит
// запрос по каждому черновику отдельно. Ответ помнит ключ своего запроса (текст и
// выбор): ответ на устаревший ключ отбрасывается, иначе медленный ответ на прежний
// текст перетёр бы прогноз нового.
import { useEffect, useRef, useState } from "react";
import { processesApi } from "../../api/processes";
import type { ProcessImportPreview } from "../../types";

const PREVIEW_DELAY = 400;

/** Что нужно превью от черновика: текст для запроса и выбор человека (алиас → id узла,
 *  пустая строка — оставить без объекта). */
interface PreviewInput {
  key: string;
  body: string;
  choice: Record<string, string>;
}

export interface PreviewResult {
  // Ключ запроса, на который пришёл ответ (requestKey).
  reqKey: string;
  preview: ProcessImportPreview | null;
  error: string | null;
}

/** Уточнения сопоставления для превью: снятый выбор лежит пустой строкой, бэкенду он
 *  нужен как null (|| вместо ??: пустая строка ушла бы невалидным uuid). */
function overridesOf(choice: Record<string, string>): Record<string, string | null> {
  return Object.fromEntries(Object.entries(choice).map(([a, v]) => [a, v || null]));
}

/** Ключ запроса превью: по нему ответ узнаёт, не устарел ли он. */
export function requestKey(d: PreviewInput): string {
  return JSON.stringify([d.body, overridesOf(d.choice)]);
}

/** Последние ответы превью по ключу черновика. Свежий ли ответ, решает вызывающий,
 *  сравнивая reqKey ответа с requestKey черновика: пока новый запрос в пути, показывать
 *  прежний прогноз лучше, чем мигать пустотой. */
export function useImportPreviews(drafts: PreviewInput[]): Record<string, PreviewResult> {
  const [results, setResults] = useState<Record<string, PreviewResult>>({});
  // Ключ, который черновик ждёт сейчас (запланирован или в пути); ответ на другой —
  // устарел.
  const wanted = useRef(new Map<string, string>());
  const timers = useRef(new Map<string, number>());

  useEffect(() => {
    const live = new Set(drafts.map((d) => d.key));
    // Убранные черновики: таймеры снять, поздние ответы отбросить.
    for (const [k, t] of timers.current) {
      if (!live.has(k)) { window.clearTimeout(t); timers.current.delete(k); }
    }
    for (const k of wanted.current.keys()) if (!live.has(k)) wanted.current.delete(k);

    for (const d of drafts) {
      const reqKey = d.body.trim() ? requestKey(d) : "";
      if (wanted.current.get(d.key) === reqKey) continue;
      wanted.current.set(d.key, reqKey);
      const old = timers.current.get(d.key);
      if (old !== undefined) { window.clearTimeout(old); timers.current.delete(d.key); }
      if (!reqKey) continue; // пустой текст разбирать нечего
      const overrides = overridesOf(d.choice);
      const body = d.body;
      timers.current.set(d.key, window.setTimeout(() => {
        timers.current.delete(d.key);
        const accept = (r: Omit<PreviewResult, "reqKey">) => {
          if (wanted.current.get(d.key) !== reqKey) return; // ответ на прежний текст
          setResults((cur) => ({ ...cur, [d.key]: { reqKey, ...r } }));
        };
        processesApi
          .importPreview({ text: body, overrides: Object.keys(overrides).length ? overrides : null })
          .then(
            (preview) => accept({ preview, error: null }),
            (e: unknown) => accept({
              preview: null,
              error: e instanceof Error ? e.message : "Не удалось разобрать диаграмму",
            }),
          );
      }, PREVIEW_DELAY));
    }
  }, [drafts]);

  // Размонтирование: таймеры снять, ответы в пути никуда не писать.
  useEffect(() => {
    const t = timers.current;
    const w = wanted.current;
    return () => {
      for (const id of t.values()) window.clearTimeout(id);
      t.clear();
      w.clear();
    };
  }, []);

  return results;
}
