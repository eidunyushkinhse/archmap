/// <reference types="node" />
// Node-типы точечно: тест дочитывает с диска golden-файл фазз-полигона (как
// routerFuzz.golden.test.ts) — app-tsconfig остаётся браузерным.
//
// МЕХАНИЧЕСКИЙ СТОРОЖ ПРОТУХАНИЯ КЭША МАРШРУТОВ (Ф2 эпика router-opt, риск R2 плана;
// спека perf.md P11). Персистный кэш валидируется по routeSig — а она описывает только
// ВХОДЫ сцены и не видит КОНТРАКТА АЛГОРИТМА. Любая правка контракта обязана
// инвалидировать все ранее записанные кэши, и это гарантируется НЕ дисциплиной, а этим
// тестом: изменил контракт, не бампнув ROUTER_VERSION, — CI красный.
//
// ХЭШ КОНТРАКТА ДВУХСЛОЙНЫЙ (Ф4-I, 2026-08-21):
//   слой 1 — канонический текст РЕЕСТРА КОНСТАНТ (routerVersion.collectRouterConstants);
//   слой 2 — ПОВЕДЕНЧЕСКИЙ ДОВЕСОК: хэш СОДЕРЖИМОГО __tests__/golden/routerFuzz.json.
// Второй слой ловит правки, которые двигают маршруты БЕЗ смены констант: такая правка
// обязана перегенерировать golden полигона, а значит меняет хэш контракта механикой.
// Довесок считается ЗДЕСЬ, а не в routerVersion.ts: тот модуль едет в бандл воркера,
// и чтения фикстуров с диска в нём быть не может.
// ОХВАТ ДОВЕСКА (честно): golden считается по пути buildAutoRoutes — порты, A*, rip-up,
// раздача слотов, сварка, штрафы рамок/плашек. Полигон НЕ гоняет канальный нуджинг,
// спрямление джогов и размещение плашек: правки этих стадий довесок не увидит, для них
// работает ручной слой ROUTER_ALGO_REV.
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ROUTER_VERSION, ROUTER_ALGO_REV, CONTRACT_HASH_BY_VERSION,
  collectRouterConstants, canonicalRouterConstants, hashRouterConstants,
} from "../graph/layout/routerVersion";
import { hashOf } from "./routerFuzz";

// Путь к golden строим ПО ЧАСТЯМ: литерал `new URL("./…", import.meta.url)` Vite
// переписывает в ассет-URL (схема http), и fileURLToPath на нём падает (ловушка
// задокументирована в routerFuzz.golden.test.ts).
const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "golden", "routerFuzz.json");

const PROTOCOL = [
  "",
  "ХЭШ КОНТРАКТА РОУТЕРА РАЗОШЁЛСЯ С ЗАРЕГИСТРИРОВАННЫМ ДЛЯ ROUTER_VERSION.",
  "",
  "Это не «поправить тест». Кэш маршрутов вида (perf.md P11) отдаёт готовую",
  "геометрию при совпадении routeSig, а sig не видит контракта алгоритма: записи,",
  "сделанные ДО правки, при той же сцене вернут СТАРЫЕ маршруты.",
  "",
  "ЧТО ИМЕННО РАЗОШЛОСЬ — смотри по причине:",
  "  • правил КОНСТАНТУ реестра (штраф, зазор, габарит) — так и задумано;",
  "  • перегенерировал golden фазз-полигона — значит правка сдвинула маршруты",
  "    роутерного ядра, и кэш обязан протухнуть;",
  "  • бампнул ROUTER_ALGO_REV — ручная ревизия алгоритма, так и задумано.",
  "",
  "ПРОТОКОЛ: в routerVersion.ts бампни ROUTER_VERSION на 1 и добавь в",
  "CONTRACT_HASH_BY_VERSION пару «новая версия → новый хэш» (см. текст ошибки —",
  "хэш в поле received). Старые пары НЕ трогай: это история.",
  "Если константа геометрии НОВАЯ — сначала внеси её в collectRouterConstants.",
  "Если геометрия поехала БЕЗ правки констант и вне охвата полигона (нуджинг,",
  "джоги, плашки) — бампни ROUTER_ALGO_REV, иначе сторож промолчит.",
  "",
].join("\n");

/** Поведенческий довесок: хэш содержимого golden-файла фазз-полигона. */
const behaviorAddendum = (): string =>
  `golden.routerFuzz=${hashOf(readFileSync(GOLDEN_PATH, "utf8"))}`;

/** Живой хэш контракта: реестр констант ⧺ поведенческий довесок. */
const liveContractHash = (): string =>
  hashOf(`${canonicalRouterConstants()}\n${behaviorAddendum()}`);

describe("ROUTER_VERSION — сторож контракта роутера", () => {
  it("golden фазз-полигона на месте (без него второй слой сторожа мёртв)", () => {
    expect(
      existsSync(GOLDEN_PATH),
      `нет golden-файла (${GOLDEN_PATH}). Сгенерировать (из frontend/): ` +
      "ARCHMAP_FUZZ_WRITE=1 npx vitest run routerFuzz",
    ).toBe(true);
    expect(readFileSync(GOLDEN_PATH, "utf8").length).toBeGreaterThan(1000);
  });

  it("хэш живого контракта равен зарегистрированному для текущей версии", () => {
    const live = liveContractHash();
    expect(CONTRACT_HASH_BY_VERSION[ROUTER_VERSION], PROTOCOL + `живой хэш: ${live}\n`).toBe(live);
  });

  it("реестр покрывает все семьи констант геометрии и детерминирован", () => {
    const reg = collectRouterConstants();
    // семьи из карты «модуль → константы» (шапка routerVersion.ts)
    for (const prefix of [
      "orthoRoute.", "routeAll.", "weldTrunks.", "autoRoutes.",
      "channelNudge.", "frames.", "labelBox.", "constants.", "routerVersion.",
    ]) {
      expect(Object.keys(reg).some((k) => k.startsWith(prefix)), `нет констант семьи ${prefix}`).toBe(true);
    }
    // ни одного undefined (опечатка в импорте молча выпала бы из хэша)
    for (const [k, v] of Object.entries(reg)) expect(v, `константа ${k} не собралась`).toBeDefined();
    // канонизация не зависит от порядка вызовов
    expect(canonicalRouterConstants()).toBe(canonicalRouterConstants());
    expect(hashRouterConstants()).toBe(hashRouterConstants());
    expect(liveContractHash()).toBe(liveContractHash());
  });

  it("оба слоя реально входят в хэш контракта", () => {
    // слой 1: ревизия алгоритма — в каноническом тексте реестра
    expect(canonicalRouterConstants()).toContain(`routerVersion.ROUTER_ALGO_REV=${ROUTER_ALGO_REV}`);
    // слой 2: довесок чувствителен к СОДЕРЖИМОМУ golden, а не к факту его наличия
    const live = liveContractHash();
    const tampered = hashOf(`${canonicalRouterConstants()}\ngolden.routerFuzz=${hashOf("другое содержимое")}`);
    expect(tampered, "довесок не влияет на хэш — второй слой мёртв").not.toBe(live);
  });

  it("история версий: текущая версия зарегистрирована, хэши версий не повторяются", () => {
    expect(Object.keys(CONTRACT_HASH_BY_VERSION)).toContain(String(ROUTER_VERSION));
    const hashes = Object.values(CONTRACT_HASH_BY_VERSION);
    expect(new Set(hashes).size, "две версии с одинаковым хэшем — версия бампнута зря").toBe(hashes.length);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
