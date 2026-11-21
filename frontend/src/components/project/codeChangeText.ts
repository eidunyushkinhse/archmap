// Тексты плашки «Документацию пора обновить» (CodeChangeNotice.tsx): строка на репозиторий
// из сигнала CI и подсказка со списком объектов.
import type { CodeChangeAlert } from "../../types";
import { plural } from "../../ui/plural";

// Объектов в подсказке строки: дальше числом.
const NAMES_SHOWN = 8;

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

/** «gitlab.example.org/market/shop: с 18 ноября 3 слияния в main. Документацию 5
 *  объектов пора обновить.» */
export function changeLine(c: CodeChangeAlert): string {
  const merges = `${c.merges} ${plural(c.merges, ["слияние", "слияния", "слияний"])}`;
  const into = c.branch ? ` в ${c.branch}` : "";
  const n = c.nodes.length;
  return (
    `${c.repo}: с ${fmtDay(c.first_at)} ${merges}${into}. ` +
    `Документацию ${n} ${plural(n, ["объекта", "объектов", "объектов"])} пора обновить.`
  );
}

export function namesHint(c: CodeChangeAlert): string {
  const names = c.nodes.slice(0, NAMES_SHOWN).map((n) => n.node_name);
  const rest = c.nodes.length - names.length;
  return names.join(", ") + (rest > 0 ? ` и ещё ${rest}` : "");
}
