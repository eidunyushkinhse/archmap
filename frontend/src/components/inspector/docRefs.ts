// Пометки обращений в тексте схемы логики («читает:/пишет:», «публикует:/потребляет:»,
// «зависит от:»): локальный гейт, слова причин и сборка строк. Общие для строк обращений
// при правке (FlowchartDoc) и строки неразрешённых обращений в подвале чтения
// (FlowchartView): слова в обоих местах собирает один модуль.
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
// пометки (см. reasonOf): «база / таблица» у данных, «брокер / канал» у событий.
const REF_REASON: Record<Exclude<DataRefPreviewItem["status"], "ok">, string> = {
  unknown_table: "таблица не найдена",
  ambiguous: "таблица с таким именем есть в нескольких базах, укажите «база / таблица»",
  unknown_column: "колонки нет в таблице",
  unknown_channel: "канал не найден у брокеров проекта",
  unknown_field: "поля нет в канале",
  // Искать негде, кроме самого объекта, — так и говорим: у конфигурации нет ни
  // квалификатора, ни неоднозначности.
  unknown_param: "параметра нет в конфигурации этого объекта",
};
const AMBIGUOUS_CHANNEL = "канал с таким именем есть у нескольких брокеров, укажите «брокер / канал»";

const isChannelMode = (mode: DataRefPreviewItem["mode"]): boolean =>
  mode === "publish" || mode === "consume";

function reasonOf(
  status: Exclude<DataRefPreviewItem["status"], "ok">,
  mode: DataRefPreviewItem["mode"],
): string {
  return status === "ambiguous" && isChannelMode(mode) ? AMBIGUOUS_CHANNEL : REF_REASON[status];
}

// Подпись действия. Слова каналов свои: «публикует» — не «пишет», и путать их
// нельзя (разные вопросы к карте, разные каталоги резолва).
const MODE_LABEL: Record<DataRefPreviewItem["mode"], string> = {
  read: "читает",
  write: "пишет",
  publish: "публикует",
  consume: "потребляет",
  config: "зависит от",
};

// Владелец разрешённого обращения. target с бэка — «{владелец} · {имя}» («БД заказов ·
// orders», «Конфигурация · MAX_ITEMS»): имя уже стоит в строке, хвост « · {имя}»
// отбрасываем. Хвост другой (имя с квалификатором «база / таблица») — target целиком.
export function refOwner(target: string, ref: string): string {
  const tail = ` · ${ref}`;
  return target.endsWith(tail) && target.length > tail.length ? target.slice(0, -tail.length) : target;
}

// Строка обращения при правке: слово действия, имя (его место вызова пишет
// моноширинным) и хвост. Разрешённое: «пишет orders → БД заказов»; неразрешённое:
// «пишет ordrs: таблица не найдена», у «нет колонки» и «нет поля» с найденной таблицей
// или каналом в скобках: иначе непонятно, с чем сверяться.
export interface RefLine {
  ok: boolean;
  lead: string; // «пишет »
  name: string; // «orders»
  tail: string; // « → БД заказов» или «: таблица не найдена»
}

export function refLine(r: DataRefPreviewItem): RefLine {
  const lead = `${MODE_LABEL[r.mode]} `;
  if (r.status === "ok") {
    return { ok: true, lead, name: r.ref, tail: r.target ? ` → ${refOwner(r.target, r.ref)}` : "" };
  }
  const found = (r.status === "unknown_column" || r.status === "unknown_field") && r.target ? ` (${r.target})` : "";
  return { ok: false, lead, name: r.ref, tail: `: ${reasonOf(r.status, r.mode)}${found}` };
}

// Неразрешённые обращения одной строкой для подвала чтения: «{слово действия} {имя}:
// {причина}» через «; », первая буква строки заглавная (таблицу в скобках подвал не
// называет: так было принято в фазе 7а). Все разрешились — null.
export function unresolvedLine(refs: DataRefPreviewItem[]): string | null {
  const parts = refs.flatMap((r) =>
    r.status === "ok" ? [] : [`${MODE_LABEL[r.mode]} ${r.ref}: ${reasonOf(r.status, r.mode)}`]);
  if (parts.length === 0) return null;
  const line = parts.join("; ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
