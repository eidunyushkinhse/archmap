// ПЕРСИСТНЫЙ КЭШ МАРШРУТОВ ВИДА (Ф2 эпика «глубокая оптимизация роутера», спека
// perf.md P11).
//
// ЗАЧЕМ. Открытие уровня — единственный сценарий, где скоуп и гистерезис бессильны:
// prev пуст, конвейер считает роутер целиком (секунды на тяжёлой сцене). Но
// пользователь чаще всего возвращается к сцене, которую УЖЕ считали. Конвейер умеет
// «входы роутинга совпали по битам (routeSig) → результат целиком из prev»; этот
// модуль даёт prev пережить уход с вида и перезагрузку страницы.
//
// ЧТО ГАРАНТИРУЕТСЯ. Валидный кэш = БАЙТ-В-БАЙТ то, что вернул бы полный прогон:
// записывается только авторитетный результат (PipelineOutput.authoritative), читается
// только при совпадении routeSig (сцена) И ROUTER_VERSION (константы алгоритма).
// Свежесть — единственное, чем платим; качеством не платим ничем.
//
// ХРАНИЛИЩЕ. Интерфейс абстрактный (решение пользователя 2026-08-21: старт с
// localStorage, view_state — вторым этапом при спросе на кросс-девайс). Всё
// взаимодействие с localStorage — в try/catch: приватный режим, отключённое
// хранилище, переполненная квота и битый JSON деградируют до «кэша нет», а не до
// исключения посреди раскладки.
import type { EdgePoint } from "../../../types";
import type { LabelPlacement } from "./labelLayout";
import { ROUTER_VERSION } from "./routerVersion";

/** Версия ФОРМАТА записи (структура полей). Меняется отдельно от ROUTER_VERSION. */
export const FORMAT_VERSION = 1;

export type EdgeHandlePair = { sourceHandle: string; targetHandle: string };

/** Запись кэша: Map'ы разложены в массивы пар (JSON их не переживает). */
export interface RouteCacheEntry {
  v: number;    // ROUTER_VERSION записи
  fmt: number;  // FORMAT_VERSION записи
  sig: string;  // routeSig прогона — ключ валидности по сцене
  routes: [string, EdgePoint[]][];
  handles: [string, EdgeHandlePair][];
  labels: [string, LabelPlacement][];
  at: number;   // момент записи (мс эпохи) — порядок вытеснения LRU
}

/** Развёрнутая запись — то, чем её потребляет конвейер (prev*-параметры). */
export interface RouteCacheView {
  sig: string;
  routes: Map<string, EdgePoint[]>;
  handles: Map<string, EdgeHandlePair>;
  labels: Map<string, LabelPlacement>;
}

export interface RouteCacheStore {
  load(key: string): RouteCacheEntry | null;
  save(key: string, entry: RouteCacheEntry): void;
}

/** Ключ вида: проект + уровень + поверхность (карта против контекст-схемы страницы). */
export function viewCacheKey(
  projectId: string | null,
  containerId: string | null,
  layoutViewId?: string,
): string {
  return `${projectId ?? "__noproject__"}|${containerId ?? "__root__"}|${layoutViewId ?? "-"}`;
}

/** Свернуть результат прогона в запись кэша. `at` берётся вызывающим (клиентский код). */
export function toCacheEntry(
  sig: string,
  routes: Map<string, EdgePoint[]>,
  handles: Map<string, EdgeHandlePair>,
  labels: Map<string, LabelPlacement>,
  at: number,
): RouteCacheEntry {
  return {
    v: ROUTER_VERSION,
    fmt: FORMAT_VERSION,
    sig,
    routes: [...routes].map(([id, pts]) => [id, pts.map((p) => ({ x: p.x, y: p.y }))]),
    handles: [...handles],
    labels: [...labels],
    at,
  };
}

/** Развернуть запись в Map'ы для передачи конвейеру. */
export function fromCacheEntry(e: RouteCacheEntry): RouteCacheView {
  return {
    sig: e.sig,
    routes: new Map(e.routes),
    handles: new Map(e.handles),
    labels: new Map(e.labels),
  };
}

// ── localStorage-реализация ──────────────────────────────────────────────────────

const KEY_PREFIX = "archmap.routeCache:";
const INDEX_KEY = "archmap.routeCache.index";
/** Кэпы: столько записей и столько байт суммарно держим, остальное вытесняем. */
export const MAX_ENTRIES = 30;
export const MAX_TOTAL_BYTES = 3_000_000;

interface IndexRec {
  key: string;   // ключ вида (без префикса)
  at: number;    // последнее ОБРАЩЕНИЕ (LRU: чтение обновляет)
  bytes: number; // длина сериализованной записи
}

let warned = false;
function warnOnce(e: unknown): void {
  if (warned) return;
  warned = true;
  console.warn("[archmap] кэш маршрутов недоступен, работаем без него:", e);
}

/**
 * Кэш поверх localStorage: одна запись = один вид, плюс отдельный ключ-реестр для LRU
 * (перебирать сами записи ради размеров и дат было бы дороже самого кэша).
 */
export class LocalStorageRouteCache implements RouteCacheStore {
  private storage(): Storage | null {
    try {
      if (typeof localStorage === "undefined") return null;
      return localStorage;
    } catch (e) {
      warnOnce(e);
      return null;
    }
  }

  private readIndex(s: Storage): IndexRec[] {
    try {
      const raw = s.getItem(INDEX_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (r): r is IndexRec =>
          !!r && typeof r === "object"
          && typeof (r as IndexRec).key === "string"
          && typeof (r as IndexRec).at === "number"
          && typeof (r as IndexRec).bytes === "number",
      );
    } catch {
      return [];
    }
  }

  private writeIndex(s: Storage, idx: IndexRec[]): void {
    try {
      s.setItem(INDEX_KEY, JSON.stringify(idx));
    } catch (e) {
      warnOnce(e);
    }
  }

  private drop(s: Storage, idx: IndexRec[], key: string): IndexRec[] {
    try {
      s.removeItem(KEY_PREFIX + key);
    } catch (e) {
      warnOnce(e);
    }
    return idx.filter((r) => r.key !== key);
  }

  /** Вытеснение старейших, пока обе крышки не соблюдены. Возвращает новый реестр. */
  private evict(s: Storage, idx: IndexRec[]): IndexRec[] {
    let out = [...idx].sort((a, b) => a.at - b.at); // старейшие первыми
    const over = (): boolean =>
      out.length > MAX_ENTRIES || out.reduce((k, r) => k + r.bytes, 0) > MAX_TOTAL_BYTES;
    while (out.length > 0 && over()) {
      const victim = out[0];
      out = this.drop(s, out, victim.key);
    }
    return out;
  }

  load(key: string): RouteCacheEntry | null {
    const s = this.storage();
    if (!s) return null;
    try {
      const raw = s.getItem(KEY_PREFIX + key);
      if (!raw) return null;
      let entry: RouteCacheEntry | null = null;
      try {
        entry = JSON.parse(raw) as RouteCacheEntry;
      } catch {
        entry = null;
      }
      // Чужая версия роутера/формата (или битый JSON) — не наше: удаляем сразу, чтобы
      // мусор не занимал квоту и не проверялся на каждом открытии вида.
      if (!entry || entry.v !== ROUTER_VERSION || entry.fmt !== FORMAT_VERSION
        || typeof entry.sig !== "string" || !Array.isArray(entry.routes)
        || !Array.isArray(entry.handles) || !Array.isArray(entry.labels)) {
        this.writeIndex(s, this.drop(s, this.readIndex(s), key));
        return null;
      }
      // LRU по ОБРАЩЕНИЮ: вид, который открывают, не должен вытесняться раньше вида,
      // который однажды записали и забыли. Date.now() тут легален — это клиентский
      // код, а не конвейер (в конвейере часы запрещены: они убили бы детерминизм).
      const idx = this.readIndex(s);
      const rec = idx.find((r) => r.key === key);
      if (rec) {
        rec.at = Date.now();
        this.writeIndex(s, idx);
      }
      return entry;
    } catch (e) {
      warnOnce(e);
      return null;
    }
  }

  save(key: string, entry: RouteCacheEntry): void {
    const s = this.storage();
    if (!s) return;
    try {
      // ДЕДУП: та же сцена (sig) уже лежит — переписывать нечем, только квоту жечь.
      const prevRaw = s.getItem(KEY_PREFIX + key);
      if (prevRaw) {
        try {
          const prev = JSON.parse(prevRaw) as RouteCacheEntry;
          if (prev.v === ROUTER_VERSION && prev.fmt === FORMAT_VERSION && prev.sig === entry.sig) return;
        } catch {
          // битую запись просто перезапишем
        }
      }
      const raw = JSON.stringify(entry);
      let idx = this.readIndex(s).filter((r) => r.key !== key);
      idx.push({ key, at: entry.at, bytes: raw.length });
      idx = this.evict(s, idx);
      // Вытеснение могло убрать саму новую запись (одна запись больше всей квоты) —
      // тогда и писать её незачем.
      if (!idx.some((r) => r.key === key)) {
        this.writeIndex(s, idx);
        return;
      }
      try {
        s.setItem(KEY_PREFIX + key, raw);
      } catch (e) {
        // КВОТА: вытесняем старейшую ЧУЖУЮ запись и пробуем ровно один раз — цикл
        // «чистим, пока влезет» на забитом хранилище выродился бы в тотальную чистку.
        const others = idx.filter((r) => r.key !== key).sort((a, b) => a.at - b.at);
        if (others.length === 0) {
          warnOnce(e);
          this.writeIndex(s, this.drop(s, idx, key));
          return;
        }
        idx = this.drop(s, idx, others[0].key);
        try {
          s.setItem(KEY_PREFIX + key, raw);
        } catch (e2) {
          warnOnce(e2);
          this.writeIndex(s, this.drop(s, idx, key));
          return;
        }
      }
      this.writeIndex(s, idx);
    } catch (e) {
      warnOnce(e);
    }
  }
}

/**
 * Модульный синглтон — им пользуется LevelGraph. Подмена в тестах: vi.mock модуля
 * целиком либо (в интеграционном тесте) прямая работа с localStorage jsdom —
 * прод-кода тестовых лазеек не держит.
 */
export const routeCache: RouteCacheStore = new LocalStorageRouteCache();
