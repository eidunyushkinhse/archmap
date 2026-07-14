// Сигнатура результата раскладки (Ф1 эпика плавности анимаций): механическая
// сериализация ВСЕХ полей LayoutResult. Нужна для скипа идентичных применений:
// зеркальные прогоны (зеркало засева own-on-first-render, зеркало expanded)
// дают результат, идентичный уже применённому ПО ПОСТРОЕНИЮ, — их применение
// только пересобирало бы RF-граф и дёргало тотальный ре-рендер сцены.
//
// Полнота — по построению: поля НЕ перечисляются руками (Object.keys + сортировка),
// новое поле LayoutResult попадает в сигнатуру автоматически. Тест-страж
// (layoutSig.test.ts) проверяет чувствительность к каждому текущему полю.
import type { LayoutResult } from "./pipeline";

// Map/Set сериализуются отсортированными по ключу: порядок вставки не является
// смыслом результата (потребители обращаются по ключу), а детерминизм сигнатуры
// не должен зависеть от порядка обхода стадий конвейера.
const replacer = (_k: string, v: unknown): unknown => {
  if (v instanceof Map) {
    return [...v.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1));
  }
  if (v instanceof Set) {
    return [...v.values()].map(String).sort();
  }
  return v;
};

/** Детерминированная сигнатура раскладки: равенство сигнатур ⇒ применение не нужно. */
export function layoutSig(layout: LayoutResult): string {
  const rec = layout as unknown as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(rec).sort()) {
    parts.push(k + ":" + String(JSON.stringify(rec[k], replacer)));
  }
  return parts.join("|");
}
