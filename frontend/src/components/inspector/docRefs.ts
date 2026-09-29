// Пометки обращений в тексте схемы логики («читает:/пишет:», «публикует:/потребляет:»,
// «зависит от:»): локальный гейт и слова причин. Общие для плашки «Обращения» в
// редакторе (FlowchartDoc) и строки «Обращения» в просмотре схемы (DocViewMeta).
// Отдельный модуль без компонентов — требование react-refresh.
import type { DataRefPreviewItem } from "../../types";

// Дешёвый локальный гейт: грамматику маркера держит бэк (app/data_refs.py), тут
// достаточно понять, есть ли в тексте хоть один — на доках без данных (их
// большинство) сеть не дёргается вовсе. \b не ставим: в JS он ASCII-ный и перед
// кириллическим «ч» не сработал бы. Пробел внутри двусловного маркера — \s+, как и
// на бэке: «зависит  от:» с двойным пробелом это тот же маркер.
export const REF_MARKER =
  /(читает|пишет|reads|writes|публикует|потребляет|publishes|consumes|зависит\s+от|depends\s+on)\s*:/i;

// Почему пометка не срослась — ТЕ ЖЕ слова, что в панели алертов (SchemaAlerts):
// один факт, увиденный из двух мест, не должен читаться как две разные проблемы.
// «ambiguous» общий для обеих семей, а починка разная — текст выбирается по режиму
// пометки (см. reasonOf): «БД / таблица» у данных, «Брокер / канал» у событий.
const REF_REASON: Record<Exclude<DataRefPreviewItem["status"], "ok">, string> = {
  unknown_table: "таблица не найдена",
  ambiguous: "имя неоднозначно — укажите „БД / таблица“",
  unknown_column: "колонки нет в таблице",
  unknown_channel: "канал не найден у брокеров проекта",
  unknown_field: "поля нет в канале",
  // Искать негде, кроме самого объекта, — так и говорим: у конфигурации нет ни
  // квалификатора, ни неоднозначности.
  unknown_param: "параметра нет в конфигурации этого объекта",
};
const AMBIGUOUS_CHANNEL = "имя неоднозначно — укажите „Брокер / канал“";

const isChannelMode = (mode: DataRefPreviewItem["mode"]): boolean =>
  mode === "publish" || mode === "consume";

export function reasonOf(
  status: Exclude<DataRefPreviewItem["status"], "ok">,
  mode: DataRefPreviewItem["mode"],
): string {
  return status === "ambiguous" && isChannelMode(mode) ? AMBIGUOUS_CHANNEL : REF_REASON[status];
}

// Подпись действия. Слова каналов свои: «публикует» — не «пишет», и путать их
// нельзя (разные вопросы к карте, разные каталоги резолва).
export const MODE_LABEL: Record<DataRefPreviewItem["mode"], string> = {
  read: "читает",
  write: "пишет",
  publish: "публикует",
  consume: "потребляет",
  config: "зависит от",
};
