// МЕХАНИЧЕСКИЙ СТОРОЖ ПРОТУХАНИЯ КЭША МАРШРУТОВ (Ф2 эпика router-opt, риск R2 плана;
// спека perf.md P11). Персистный кэш валидируется по routeSig — а она описывает только
// ВХОДЫ сцены и не видит КОНСТАНТ АЛГОРИТМА. Правка любой из них обязана инвалидировать
// все ранее записанные кэши, и это гарантируется НЕ дисциплиной, а этим тестом:
// изменил константу, не бампнув ROUTER_VERSION, — CI красный.
import { describe, it, expect } from "vitest";
import {
  ROUTER_VERSION, CONSTANTS_HASH_BY_VERSION,
  collectRouterConstants, canonicalRouterConstants, hashRouterConstants,
} from "../graph/layout/routerVersion";

const PROTOCOL = [
  "",
  "ХЭШ КОНСТАНТ РОУТЕРА РАЗОШЁЛСЯ С ЗАРЕГИСТРИРОВАННЫМ ДЛЯ ROUTER_VERSION.",
  "",
  "Это не «поправить тест». Кэш маршрутов вида (perf.md P11) отдаёт готовую",
  "геометрию при совпадении routeSig, а sig не видит констант алгоритма: записи,",
  "сделанные ДО правки, при той же сцене вернут СТАРЫЕ маршруты.",
  "",
  "ПРОТОКОЛ: в routerVersion.ts бампни ROUTER_VERSION на 1 и добавь в",
  "CONSTANTS_HASH_BY_VERSION пару «новая версия → новый хэш» (см. текст ошибки —",
  "хэш в поле received). Старые пары НЕ трогай: это история.",
  "Если константа геометрии НОВАЯ — сначала внеси её в collectRouterConstants.",
  "",
].join("\n");

describe("ROUTER_VERSION — сторож констант роутера", () => {
  it("хэш живого реестра равен зарегистрированному для текущей версии", () => {
    const live = hashRouterConstants();
    expect(CONSTANTS_HASH_BY_VERSION[ROUTER_VERSION], PROTOCOL + `живой хэш: ${live}\n`).toBe(live);
  });

  it("реестр покрывает все семьи констант геометрии и детерминирован", () => {
    const reg = collectRouterConstants();
    // семьи из карты «модуль → константы» (шапка routerVersion.ts)
    for (const prefix of [
      "orthoRoute.", "routeAll.", "weldTrunks.", "autoRoutes.",
      "channelNudge.", "frames.", "labelBox.", "constants.",
    ]) {
      expect(Object.keys(reg).some((k) => k.startsWith(prefix)), `нет констант семьи ${prefix}`).toBe(true);
    }
    // ни одного undefined (опечатка в импорте молча выпала бы из хэша)
    for (const [k, v] of Object.entries(reg)) expect(v, `константа ${k} не собралась`).toBeDefined();
    // канонизация не зависит от порядка вызовов
    expect(canonicalRouterConstants()).toBe(canonicalRouterConstants());
    expect(hashRouterConstants()).toBe(hashRouterConstants());
  });

  it("история версий: текущая версия зарегистрирована, хэши версий не повторяются", () => {
    expect(Object.keys(CONSTANTS_HASH_BY_VERSION)).toContain(String(ROUTER_VERSION));
    const hashes = Object.values(CONSTANTS_HASH_BY_VERSION);
    expect(new Set(hashes).size, "две версии с одинаковым хэшем — версия бампнута зря").toBe(hashes.length);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});
