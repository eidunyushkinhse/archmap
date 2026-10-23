// Режим работы оболочки проекта — «Объекты · Процессы · Развёртывание» — и его память
// между заходами (localStorage archmap_mode). Отдельный лёгкий модуль: его читает App при
// разборе адреса (до загрузки страниц — запомненное «Развёртывание» живёт в адресе
// #/p/<pid>/deploy) и сама оболочка (ProjectShell).
import { safeLocal, safeSession } from "../lib/safeStorage";

export type WorkMode = "schema" | "proc" | "deploy";

const MODE_KEY = "archmap_mode";

// Строка процессного алерта в редакторе-карте уводит в режим «Процессы» оболочки, а роут
// карты про процессы не знает — процесс передаётся ключом sessionStorage (2026-08-11).
export const PENDING_PROCESS_KEY = "archmap.pendingProcess";

/** Запомненный режим: только известные значения, иначе «Объекты». */
export function storedMode(): WorkMode {
  const v = safeLocal.getItem(MODE_KEY);
  return v === "proc" || v === "deploy" ? v : "schema";
}

export function storeMode(mode: WorkMode): void {
  safeLocal.setItem(MODE_KEY, mode);
}

/**
 * Открыть страницу проекта сразу в «Развёртывании»: этот режим запомнен, и из редактора
 * не пришли с процессом (переход к процессу важнее запомненного режима).
 */
export function deployRemembered(): boolean {
  return storedMode() === "deploy" && safeSession.getItem(PENDING_PROCESS_KEY) === null;
}
