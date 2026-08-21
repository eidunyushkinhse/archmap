// ТЕСТ ИДЕНТИЧНОСТИ КУЧИ A* (А4 эпика «глубокая оптимизация роутера», 2026-08-21).
//
// Правка А4 сменила ХРАНИЛИЩЕ MinHeap (number[] → Int32Array/Float64Array), не тронув
// логику. Опасность правки не в «сломается», а в «поплывут ТАЙ-БРЕЙКИ»: A* сплошь и рядом
// достаёт состояния с РАВНЫМИ приоритетами, и порядок их извлечения определяет, какой из
// равноценных маршрутов станет ответом. Изменись он — метрики качества остались бы
// зелёными, а геометрия стрелок поехала бы молча.
//
// Поэтому здесь эталон — ДОСЛОВНАЯ копия прежней кучи на обычных массивах (RefMinHeap
// ниже), и сверяется ПОЛНАЯ pop-последовательность обеих куч на детерминированных
// потоках операций. Ключи в потоках уникальны и служат «биркой»: совпадение
// последовательности ключей при массовых ничьих в приоритетах и есть доказательство
// идентичности разрешения ничьих.
import { describe, it, expect } from "vitest";
import { MinHeap } from "../graph/layout/orthoRoute";
import { mulberry32 } from "./routerFuzz";

// ЭТАЛОН: куча ДО правки А4, скопирована дословно (parallel number[]-массивы).
class RefMinHeap {
  private keys: number[] = [];
  private prio: number[] = [];
  get size(): number { return this.keys.length; }
  push(key: number, p: number): void {
    this.keys.push(key); this.prio.push(p);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent); i = parent;
    }
  }
  pop(): number {
    const top = this.keys[0];
    const k = this.keys.pop() ?? 0; const p = this.prio.pop() ?? 0;
    if (this.keys.length > 0) {
      this.keys[0] = k; this.prio[0] = p;
      const n = this.keys.length; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2; let m = i;
        if (l < n && this.prio[l] < this.prio[m]) m = l;
        if (r < n && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    const tk = this.keys[a]; this.keys[a] = this.keys[b]; this.keys[b] = tk;
    const tp = this.prio[a]; this.prio[a] = this.prio[b]; this.prio[b] = tp;
  }
}

// Операция потока: либо push(key, prio), либо pop (pop исполняется только при size > 0 —
// ровно как в routePorts, где pop зовётся под `while (open.size > 0)`).
type Op = { push: [number, number] } | { pop: true };

// Прогон потока обеими кучами: трасса — размер после каждой операции и ключи всех pop.
function trace(ops: Op[], heap: { size: number; push(k: number, p: number): void; pop(): number }): string[] {
  const out: string[] = [];
  for (const op of ops) {
    if ("push" in op) {
      heap.push(op.push[0], op.push[1]);
      out.push(`+${op.push[0]}=${heap.size}`);
    } else if (heap.size > 0) {
      out.push(`-${heap.pop()}=${heap.size}`);
    }
  }
  // добиваем до пустоты — хвост последовательности не менее важен, чем интерливинг
  while (heap.size > 0) out.push(`-${heap.pop()}=${heap.size}`);
  return out;
}

const bothSame = (ops: Op[]): void => {
  expect(trace(ops, new MinHeap())).toEqual(trace(ops, new RefMinHeap()));
};

describe("MinHeap A* — идентичность новой (типизированной) кучи и прежней", () => {
  it("детерминированные потоки push/pop с массовыми ничьими приоритетов", () => {
    // 12 сидов × ~400 операций. Приоритеты — ЦЕЛЫЕ из узкого диапазона: ничьи неизбежны
    // в каждой куче, а значит проверяется именно порядок их разрешения.
    for (let seed = 1; seed <= 12; seed++) {
      const rnd = mulberry32(seed);
      const ops: Op[] = [];
      let live = 0;
      for (let n = 0; n < 400; n++) {
        // смещение в сторону push, чтобы куча реально наполнялась (глубокие sift-down)
        if (live === 0 || rnd() < 0.62) {
          ops.push({ push: [n, Math.floor(rnd() * 8)] });
          live++;
        } else {
          ops.push({ pop: true });
          live--;
        }
      }
      bothSame(ops);
    }
  });

  it("все приоритеты одинаковые — порядок извлечения совпадает", () => {
    for (const total of [1, 2, 3, 7, 8, 15, 16, 100]) {
      const ops: Op[] = [];
      for (let i = 0; i < total; i++) ops.push({ push: [i, 42] });
      bothSame(ops);
    }
  });

  it("монотонные потоки: по возрастанию, по убыванию, чередование", () => {
    const asc: Op[] = [], desc: Op[] = [], zig: Op[] = [];
    for (let i = 0; i < 200; i++) {
      asc.push({ push: [i, i] });
      desc.push({ push: [i, 200 - i] });
      zig.push({ push: [i, i % 2 === 0 ? i : 200 - i] });
    }
    bothSame(asc); bothSame(desc); bothSame(zig);
  });

  it("pop до пустоты и push после опустошения (буфер переиспользуется)", () => {
    const ops: Op[] = [];
    for (let round = 0; round < 5; round++) {
      const rnd = mulberry32(100 + round);
      for (let i = 0; i < 30; i++) ops.push({ push: [round * 100 + i, Math.floor(rnd() * 4)] });
      for (let i = 0; i < 30; i++) ops.push({ pop: true }); // ровно до пустоты
    }
    bothSame(ops);
    // отдельно: одна и та же новая куча переживает несколько циклов «наполнить/опустошить»
    const heap = new MinHeap();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 50; i++) heap.push(i, (i * 7) % 5);
      const got: number[] = [];
      while (heap.size > 0) got.push(heap.pop());
      const ref = new RefMinHeap();
      for (let i = 0; i < 50; i++) ref.push(i, (i * 7) % 5);
      const want: number[] = [];
      while (ref.size > 0) want.push(ref.pop());
      expect(got).toEqual(want);
    }
  });

  it("дробные приоритеты: точность double сохранена (не float32)", () => {
    // Приоритеты A* — суммы длин/штрафов, различающиеся в 10-м знаке. Float32Array
    // схлопнул бы такие пары в одно значение и поменял бы разрешение ничьей.
    const ops: Op[] = [];
    for (let i = 0; i < 64; i++) ops.push({ push: [i, 1 + i * 1e-9] });
    for (let i = 64; i < 128; i++) ops.push({ push: [i, 1 + (127 - i) * 1e-9] });
    bothSame(ops);
    // прямая проверка: сосед по 1e-9 не считается равным
    const heap = new MinHeap();
    heap.push(1, 1.000000002);
    heap.push(2, 1.000000001);
    expect([heap.pop(), heap.pop()]).toEqual([2, 1]);
  });

  it("рост буфера за начальную ёмкость не ломает порядок", () => {
    // Начальная ёмкость кучи — 1024 элемента; поток обязан пережить несколько удвоений.
    const rnd = mulberry32(777);
    const ops: Op[] = [];
    for (let i = 0; i < 5000; i++) ops.push({ push: [i, Math.floor(rnd() * 16)] });
    for (let i = 0; i < 1200; i++) ops.push({ pop: true });
    for (let i = 5000; i < 5600; i++) ops.push({ push: [i, Math.floor(rnd() * 16)] });
    bothSame(ops);
  });

  it("одиночный элемент и повторные вставки одного ключа", () => {
    bothSame([{ push: [5, 1] }]);
    bothSame([{ push: [5, 1] }, { pop: true }, { push: [5, 1] }]);
    bothSame([{ push: [5, 3] }, { push: [5, 1] }, { push: [5, 2] }]);
  });
});
