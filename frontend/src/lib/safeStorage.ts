// Хранилище браузера, которое не роняет приложение (аудит R-8). localStorage бывает
// недоступен: данные сайта заблокированы политикой, Safari в приватном режиме,
// встраивание в чужой iframe — тогда уже обращение к window.localStorage бросает
// SecurityError, а setItem на полной квоте — QuotaExceededError. Прямой вызов на уровне
// модуля (projectScope) не давал приложению даже стартовать.
//
// Здесь: настоящее хранилище — первым, а то, что записать в него не удалось, живёт в
// памяти вкладки (до перезагрузки). Чтение сначала смотрит память: там лежат только
// неудавшиеся записи, и они свежее того, что в хранилище.

export interface SafeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

// То, чем пользуемся у Storage. Свой тип, а не DOM-шный: модуль попадает и в сборку
// воркера раскладки (через projectScope), где DOM-типов нет — там хранилища просто нет.
interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storageOf(kind: "localStorage" | "sessionStorage"): SafeStorage {
  const memory = new Map<string, string>();
  const real = (): StorageLike | null => {
    try {
      return (globalThis as { [k in typeof kind]?: StorageLike })[kind] ?? null;
    } catch {
      return null;
    }
  };
  return {
    getItem(key) {
      const kept = memory.get(key);
      if (kept !== undefined) return kept;
      try {
        return real()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        const s = real();
        if (!s) throw new Error("хранилище недоступно");
        s.setItem(key, value);
        memory.delete(key);
      } catch {
        memory.set(key, value);
      }
    },
    removeItem(key) {
      memory.delete(key);
      try {
        real()?.removeItem(key);
      } catch {
        // недоступно — в памяти ключа уже нет, этого достаточно
      }
    },
    keys() {
      const out = new Set(memory.keys());
      try {
        const s = real();
        for (let i = 0; s && i < s.length; i++) {
          const k = s.key(i);
          if (k !== null) out.add(k);
        }
      } catch {
        // недоступно — только память
      }
      return [...out];
    },
  };
}

export const safeLocal: SafeStorage = storageOf("localStorage");
export const safeSession: SafeStorage = storageOf("sessionStorage");
