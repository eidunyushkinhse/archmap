// ER-диаграмма как ПРОИЗВОДНОЕ представление структуры БД.
//
// Правда — записи (таблицы/колонки), а диаграмма собирается из них здесь. Решение
// пользователя 2026-08-12: хранить структуру текстом mermaid нельзя, иначе обратный
// индекс «кто трогает orders.status» пришлось бы добывать парсингом картинки.
// Чистая функция без React — её и проверяют тесты (в т.ч. настоящим парсером mermaid).
//
// ГРАНИЦЫ СИНТАКСИСА erDiagram проверены на mermaid 11.15 живым парсером, не по
// документации (пробы 2026-08-12):
//   • имя сущности в кавычках выдерживает пробелы и кириллицу — берём его всегда;
//   • у атрибута ОБЯЗАТЕЛЬНЫ и тип, и имя: «status» без типа не парсится, поэтому
//     пустой тип заменяем на «_»;
//   • имя атрибута с пробелом не парсится (кавычки там не спасают) — схлопываем;
//   • кавычка внутри комментария ломает разбор — вырезаем;
//   • связь без метки («a ||--o{ b :») не парсится, пустая метка («: ""») — да.
import type { DbColumn, DbTable } from "../types";

// Имя сущности: полное («контур.таблица»), в кавычках — так выдерживает пробелы и
// кириллицу. Внутренние кавычки убираем, иначе строка закроется раньше времени.
function entity(t: DbTable): string {
  const full = t.schema_name ? `${t.schema_name}.${t.name}` : t.name;
  return `"${full.replace(/"/g, "")}"`;
}

// Токен-идентификатор атрибута: без пробелов и кавычек (см. границы синтаксиса).
function token(s: string): string {
  return s.trim().replace(/"/g, "").replace(/\s+/g, "_") || "_";
}

function attribute(c: DbColumn): string {
  const keys = [c.is_primary_key ? "PK" : null, c.references_column_id ? "FK" : null]
    .filter(Boolean)
    .join(", ");
  // Смысл значения — в комментарий: у enum-подобных колонок именно он и отвечает на
  // вопрос сопровождения («status: new|paid|shipped»).
  const comment = (c.description ?? "").replace(/"/g, "").trim();
  return [
    "    ",
    token(c.type),
    " ",
    token(c.name),
    keys ? ` ${keys}` : "",
    comment ? ` "${comment}"` : "",
  ].join("");
}

/**
 * Текст mermaid `erDiagram` по таблицам узла. Пустой список даёт диаграмму без
 * сущностей — она валидна и рисуется пустой, отдельного «нет данных» не требуется.
 */
export function tablesToErDiagram(tables: DbTable[]): string {
  const lines: string[] = ["erDiagram"];
  // Колонка → её таблица: по этой карте внешние ключи превращаются в связи.
  const tableOfColumn = new Map<string, DbTable>();
  for (const t of tables) for (const c of t.columns) tableOfColumn.set(c.id, t);

  for (const t of tables) {
    lines.push(`  ${entity(t)} {`);
    for (const c of t.columns) lines.push(attribute(c));
    lines.push("  }");
  }

  // Связи по внешним ключам карты. Кардинальность честная: со стороны ссылающейся
  // таблицы строк много, со стороны цели — одна; обязательность FK различает
  // «ровно одна» (}|) и «ноль или одна» (}o).
  const rels: string[] = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.references_column_id) continue;
      const target = tableOfColumn.get(c.references_column_id);
      // Цель могла уехать вместе со своей таблицей — связь молча пропускаем:
      // диаграмма не место для сообщений об ошибках.
      if (!target || target.id === t.id) continue;
      const left = c.nullable ? "}o" : "}|";
      rels.push(`  ${entity(t)} ${left}--|| ${entity(target)} : "${token(c.name)}"`);
    }
  }
  rels.sort();
  lines.push(...rels);
  return lines.join("\n");
}
