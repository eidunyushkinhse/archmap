// ИНКРЕМЕНТАЛЬНЫЙ СКОУП ПЕРЕСЧЁТА МАРШРУТОВ (Ф3 эпика «глубокая оптимизация роутера»,
// спека edge.md E84). Обобщение скоупа драга (E82) на ЛЮБОЙ прогон с валидным prev:
// раскрытие/сворачивание контейнера меняет ОКРЕСТНОСТЬ, а платит сейчас вся сцена
// (Zabbix: раскрытия по 10–14с полного роутинга).
//
// ИДЕЯ. Конвейер знает финальные позиции ТЕКУЩЕГО прогона и получает снимок финальных
// позиций ПРОШЛОГО (PipelineInput.prevScene). Диффом строится «грязная зона» —
// объединение тел изменившихся узлов В ОБОИХ состояниях (старом и новом), раздутых на
// клиренс. Ребро попадает в скоуп, если его конец изменился, если prev-маршрута нет,
// или если prev-маршрут режет грязную зону. Остальные рёбра — замороженный preplaced-
// контекст (механика E82: frozenRoutes/restoreFrozen в pipeline.ts).
//
// ПОЧЕМУ ЭТО КОРРЕКТНО (граница жертвы). Замороженный маршрут остаётся ВАЛИДНЫМ:
// единственное, что могло его сломать — новое тело на его линии, а это ровно грязная
// зона, и такое ребро уходит в скоуп. Не гарантируется ОПТИМАЛЬНОСТЬ: незаскоупленное
// ребро не подбирает опосредованных улучшений (чужой маршрут ушёл — крест можно было
// бы снять), слоты не передистрибутируются. Полный перечень жертв — E84.
//
// ДЕТЕРМИНИЗМ. Ни одна ветка не зависит от порядка итерации Map: ключи сортируются,
// рёбра обходятся в порядке массива групп, результат собирается отсортированным.
import type { EdgePoint } from "../../../types";
import type { EdgeGroup } from "../types";
import { pathCrossesRects, type NodeRect } from "../edgePath";
import { NODE_W, NODE_H } from "../constants";

/** Снимок ФИНАЛЬНОЙ сцены прогона: позиции и габариты, по которым считались маршруты. */
export interface PrevScene {
  positions: ReadonlyMap<string, { x: number; y: number }>;
  sizes: ReadonlyMap<string, { w: number; h: number }>;
}

/**
 * КЛИРЕНС ГРЯЗНОЙ ЗОНЫ. Насколько раздувается тело изменившегося узла: маршрут,
 * прошедший ближе этого расстояния, считается затронутым изменением и уходит в скоуп.
 *
 * ВЫБОР 40 = 12 + 14 + 14. Слагаемые — реальные дистанции, на которых чужой узел
 * влияет на геометрию линии:
 *   - `orthoRoute.DEFAULT_MARGIN = 12` — верхняя ступень лестницы клиренса: линия,
 *     проходящая дальше 12px от тела, телом не ограничена вовсе;
 *   - `channelNudge.NUDGE_GAP = 14` — шаг разводки параллельных плеч: сдвинутый узел
 *     переупорядочивает канал не только на своей линии, но и на соседней полосе;
 *   - ещё 14 (одна полоса канала) — запас на то, что зона строится по ТЕЛУ узла, а
 *     плашка его подписи и стаб выхода (EDGE_STUB) живут снаружи тела.
 * Больше — скоуп раздувается до полного пересчёта (порог ниже) и выигрыш исчезает;
 * меньше — замороженная линия остаётся впритирку к приехавшему узлу.
 * ВНИМАНИЕ: константа входит в реестр ROUTER_VERSION (routerVersion.ts) — правка
 * требует бампа версии по протоколу в шапке реестра.
 */
export const ROUTE_SCOPE_PAD = 40;

/**
 * ПОРОГ ОТКАЗА ОТ СКОУПА. Доля рёбер-кандидатов, выше которой инкрементальный путь
 * бессмыслен: накладные расходы (заморозка, restoreFrozen после каждого прохода,
 * T4-исключения) не окупаются, а качество ХУЖЕ полного пересчёта — большая часть сцены
 * всё равно перекладывается, но уже с замороженным контекстом остатка. Дешевле и
 * честнее пересчитать всё. Тоже в реестре ROUTER_VERSION.
 */
export const SCOPE_FULL_RECALC_SHARE = 0.6;

/** Квант «узел не двигался» — тот же 0.5px, что у EPS роутера и валидации prev (E36). */
const MOVE_EPS = 0.5;

/**
 * Ключ порта для ЗАМЫКАНИЯ ПО СТВОЛАМ. Тот же квант (·2 с округлением), что у
 * `weldTrunks.portKey`: рёбра, которые сварка считает членами одного веера, обязаны
 * попадать в скоуп ВМЕСТЕ — иначе перепроложенный лидер уедет, а followers останутся
 * висеть кусками бывшего общего ствола.
 */
const portKey = (p: EdgePoint): string => `${Math.round(p.x * 2)}|${Math.round(p.y * 2)}`;

export interface IncrementalScopeParams {
  // финальные позиции ТЕКУЩЕГО прогона (после инвариантов/A10/рамок — дальше по
  // конвейеру позиции не меняются)
  positions: ReadonlyMap<string, { x: number; y: number }>;
  // реальные габариты текущего прогона (нет записи → фолбэк NODE_W×NODE_H, ровно как
  // у realRectOf конвейера)
  sizes: ReadonlyMap<string, { w: number; h: number }>;
  // снимок финальной сцены ПРОШЛОГО прогона
  prevScene: PrevScene;
  // мастер-рёбра сцены
  groups: readonly EdgeGroup[];
  // рёбра, которые вообще можно проложить (оба конца имеют геометрию) — знаменатель
  // порога отказа и область замыкания
  candidates: ReadonlySet<string>;
  // финальные маршруты прошлого прогона
  prevRoutes: ReadonlyMap<string, EdgePoint[]>;
  // РАМКИ ТЕКУЩЕГО прогона. Прошлых рамок в снимке нет и не будет — rect рамки есть
  // функция позиций её членов, поэтому «рамка изменилась» ⇔ «изменился хоть один член»,
  // и это видно по ТЕКУЩЕМУ составу. Две роли различаются флагом region:
  //   region = true  — рамка-ОБЛАСТЬ (раскрытый контейнер, routerFrames): её изменение
  //     меняет ландшафт внутри, поэтому прямоугольник целиком идёт в грязную зону;
  //   region = false — рамка только как ТЕЛО СТЫКОВКИ (родная рамка уровня, E40): в
  //     зону НЕ идёт (её rect — вся сцена, любой prev-маршрут его режет, и скоуп
  //     мгновенно вырождался бы в полный пересчёт), но её id — «изменившийся конец».
  frames: readonly { id: string; rect: NodeRect; memberIds: ReadonlySet<string>; region: boolean }[];
  // ДИАГНОСТИКА (необязательная): функция заполняет объект числами, объясняющими
  // вердикт — сколько сущностей переехало и каков был скоуп ДО порога отказа. Ими
  // полевой зонд и приёмка отвечают на вопрос «почему скоуп не применился».
  stats?: { changedNodes: number; rawScope: number };
}

/**
 * Скоуп пересчёта маршрутов по диффу сцены. Возвращает МНОЖЕСТВО ID РЁБЕР (не узлов —
 * в отличие от scopeNodeIds драга) либо `null` — «инкрементальный путь не применим,
 * считать всё» (изменений нет вовсе, либо их слишком много).
 */
export function computeIncrementalScope(p: IncrementalScopeParams): Set<string> | null {
  const { positions, sizes, prevScene, groups, candidates, prevRoutes, frames, stats } = p;

  const rectOf = (
    id: string,
    pos: ReadonlyMap<string, { x: number; y: number }>,
    sz: ReadonlyMap<string, { w: number; h: number }>,
  ): NodeRect | null => {
    const q = pos.get(id);
    if (!q) return null;
    const s = sz.get(id);
    return { x: q.x, y: q.y, w: s?.w ?? NODE_W, h: s?.h ?? NODE_H };
  };

  // ── 1. ИЗМЕНИВШИЕСЯ УЗЛЫ ────────────────────────────────────────────────────────
  // Сравниваем ОБА снимка симметрично: id, которого нет в одном из них, — появившийся
  // или исчезнувший, и он изменившийся по определению. Ключи сортируются — порядок
  // итерации Map на результат не влияет.
  const allIds = [...new Set([...positions.keys(), ...prevScene.positions.keys()])].sort();
  const changed = new Set<string>();
  // Грязная зона: тела изменившихся узлов в ОБОИХ состояниях, раздутые на клиренс.
  const dirtyRects: NodeRect[] = [];
  const inflate = (r: NodeRect): NodeRect => ({
    x: r.x - ROUTE_SCOPE_PAD, y: r.y - ROUTE_SCOPE_PAD,
    w: r.w + 2 * ROUTE_SCOPE_PAD, h: r.h + 2 * ROUTE_SCOPE_PAD,
  });
  for (const id of allIds) {
    const now = rectOf(id, positions, sizes);
    const was = rectOf(id, prevScene.positions, prevScene.sizes);
    const moved = !now || !was
      || Math.abs(now.x - was.x) > MOVE_EPS || Math.abs(now.y - was.y) > MOVE_EPS
      || Math.abs(now.w - was.w) > MOVE_EPS || Math.abs(now.h - was.h) > MOVE_EPS;
    if (!moved) continue;
    changed.add(id);
    if (now) dirtyRects.push(inflate(now));
    if (was) dirtyRects.push(inflate(was));
  }
  // ВАЖНО: пустое множество изменившихся узлов — НЕ повод выйти. Сцена может стоять на
  // месте, а граф — измениться (пользователь создал связь): у новой связи нет
  // prev-маршрута, она обязана проложиться, и скоуп из одного ребра — идеальный случай
  // инкремента. Выход по «нечего делать» — ниже, по ПУСТОМУ СКОУПУ.

  // ── 2. РАМКИ ────────────────────────────────────────────────────────────────────
  // Рамка с изменившимся членом изменилась сама (её rect — bbox членов с паддингом).
  // Её id становится «изменившимся концом»: рёбра, состыкованные В РАМКУ (E40), обязаны
  // перепроложиться — точка стыковки уехала вместе с рамкой. Рамка-ОБЛАСТЬ вдобавок
  // отдаёт свой прямоугольник в грязную зону: это осознанно щедро — внутри неё живут
  // плашка (жёсткое препятствие E21) и новые дети, а чужая линия, прошившая только что
  // раскрытый контейнер, читается пользователем как ошибка.
  for (const f of frames) {
    let touched = false;
    for (const m of f.memberIds) {
      if (changed.has(m)) { touched = true; break; }
    }
    if (!touched) continue;
    changed.add(f.id);
    if (f.region) dirtyRects.push(inflate(f.rect));
  }

  // ── 3. ПЕРВИЧНЫЙ СКОУП РЁБЕР ────────────────────────────────────────────────────
  const scope = new Set<string>();
  for (const g of groups) {
    if (!candidates.has(g.id)) continue;
    // конец изменился (сдвиг/рост/появление/пропажа узла или рамки-конца)
    if (changed.has(g.source) || changed.has(g.target)) { scope.add(g.id); continue; }
    const pr = prevRoutes.get(g.id);
    // prev-маршрута нет — замораживать нечего, ребро обязано проложиться
    if (!pr || pr.length < 2) { scope.add(g.id); continue; }
    // prev-маршрут режет грязную зону (семантика pathCrossesRects — та же, которой
    // конвейер ловит dirty-рёбра T4 и которой валидируется prev в E36)
    if (pathCrossesRects(pr, dirtyRects)) scope.add(g.id);
  }

  // ── 4. ЗАМЫКАНИЕ ПО СТВОЛАМ (ревью 4.2) ─────────────────────────────────────────
  // По ПОРТАМ PREV-СНИМКА, ДО прокладки: рёбра, делящие prev-p0 или prev-pN с ребром
  // скоупа, входят в скоуп вместе с ним. Иначе сварка (E78/E79) перепрокладывает лидера
  // веера, а followers остаются висеть перенятыми кусками его бывшего ствола.
  const byPort = new Map<string, string[]>();
  const portsOf = new Map<string, string[]>();
  for (const g of groups) {
    if (!candidates.has(g.id)) continue;
    const pr = prevRoutes.get(g.id);
    if (!pr || pr.length < 2) continue;
    const keys = [portKey(pr[0]), portKey(pr[pr.length - 1])];
    portsOf.set(g.id, keys);
    for (const k of keys) {
      const arr = byPort.get(k);
      if (arr) arr.push(g.id); else byPort.set(k, [g.id]);
    }
  }
  // фикспойнт обходом в ширину: очередь — рёбра, чьи порты ещё не раскрыты
  const queue = [...scope];
  for (let i = 0; i < queue.length; i++) {
    const keys = portsOf.get(queue[i]);
    if (!keys) continue;
    for (const k of keys) {
      for (const other of byPort.get(k) ?? []) {
        if (scope.has(other)) continue;
        scope.add(other);
        queue.push(other);
      }
    }
  }

  // ── 5. ПОРОГ ОТКАЗА ─────────────────────────────────────────────────────────────
  if (stats) { stats.changedNodes = changed.size; stats.rawScope = scope.size; }
  // порог считаем ДО проверки пустоты: 0 > 0.6·N ложно, порядок безразличен
  if (scope.size > SCOPE_FULL_RECALC_SHARE * candidates.size) return null;
  if (scope.size === 0) return null; // менялись только неотображаемые сущности

  // отсортированный Set: порядок вставки тоже детерминирован (сравнение снимков в тестах)
  return new Set([...scope].sort());
}
