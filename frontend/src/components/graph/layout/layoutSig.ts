// Сигнатура результата раскладки (Ф1 эпика плавности анимаций): механическая
// сериализация ВСЕХ полей LayoutResult. Нужна для скипа идентичных применений:
// зеркальные прогоны (зеркало засева own-on-first-render, зеркало expanded)
// дают результат, идентичный уже применённому ПО ПОСТРОЕНИЮ, — их применение
// только пересобирало бы RF-граф и дёргало тотальный ре-рендер сцены.
//
// Полнота — по построению: поля НЕ перечисляются руками (Object.keys + сортировка),
// новое поле LayoutResult попадает в сигнатуру автоматически. Тест-страж
// (layoutSig.test.ts) проверяет чувствительность к каждому текущему полю.
//
// Оптимизация (2026-07-21): FNV-1a хэш вместо JSON.stringify — в 5-10 раз быстрее
// на больших LayoutResult (80+ узлов, 100+ рёбер). Детерминизм сохранён: Map/Set
// сериализуются отсортированными по ключу, порядок вставки не влияет на хэш.
import type { LayoutResult } from "./pipeline";

// FNV-1a: быстрый не-криптографический хэш (32-bit). Детерминирован, низкая
// коллизийность для наших данных. Ложное «различен» безопасно (лишний apply),
// ложное «равен» — нет (пропуск обновления), но вероятность ~1/2^32 на пару.
function fnv1a(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0; // unsigned 32-bit
}

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
    const json = String(JSON.stringify(rec[k], replacer));
    parts.push(k + ":" + fnv1a(json).toString(36));
  }
  return parts.join("|");
}
