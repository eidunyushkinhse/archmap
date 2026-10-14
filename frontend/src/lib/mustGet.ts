// Чтение из Map по ключу, который заведомо есть: ключи взяты из той же карты или она
// построена по тому же списку. Вместо `map.get(k)!` под eslint-disable (аудит F-62):
// нарушенный инвариант падает здесь внятной ошибкой с ключом, а не TypeError строкой
// ниже. Значение undefined картой не хранится — такие карты сюда не годятся.
export function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`mustGet: в карте нет ключа ${String(key)}`);
  return value;
}
