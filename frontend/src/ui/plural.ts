// Русские склонения при числительных — на стандартном Intl.PluralRules('ru'),
// без внешних зависимостей. forms: [один, два-четыре, пять+].
// Пример: plural(2, ["объект", "объекта", "объектов"]) → «объекта».
const rules = new Intl.PluralRules("ru");

export function plural(n: number, forms: [string, string, string]): string {
  const r = rules.select(Math.abs(Math.trunc(n)));
  if (r === "one") return forms[0];
  if (r === "few") return forms[1];
  return forms[2];
}
