import type { FrozenDiag, PipelineInput, ScopeDiag, T4Diag } from "./pipeline";

// Диагностические глобалы конвейера и холста — одна типизация вместо одиннадцати
// `as unknown as` с копиями типов по месту (аудит F-59). Имена прежние: их по имени
// выставляют и читают зонды полигона (scripts/*-probe.mjs, .polygon), перф-тесты и
// оффлайн-реплей (scripts/replay-prof.ts). В проде ни один хук не выставлен — каждый
// вызов по месту мёртвый no-op. Работает и в Web Worker: globalThis там — свой.
export interface ArchmapDiag {
  // Трассировка стадий конвейера: пары «стадия → мс» (perf-эпик 2026-08-20).
  __ARCHMAP_TRACE?: (stage: string, ms: number) => void;
  // Сводки стадий конвейера: скоуп маршрутизации, починка T4, страховка заморозки (E84).
  __ARCHMAP_SCOPE_DIAG?: (d: ScopeDiag) => void;
  __ARCHMAP_T4_DIAG?: (d: T4Diag) => void;
  __ARCHMAP_FROZEN_DIAG?: (d: FrozenDiag) => void;
  // Захват входа конвейера для реплея: true → последний вход в __archmapLastPipelineInput.
  __archmapCaptureInput?: boolean;
  __archmapLastPipelineInput?: PipelineInput;
  // A/B-переопределение опций ELK (мокап-раннер и полигоны).
  __archmapElkOverride?: Record<string, string>;
  // Счётчики холста для зондов: раскладка в полёте / всего прогонов, версия замеров узлов.
  __archmapLayoutInflight?: number;
  __archmapLayoutRuns?: number;
  __archmapSizesVersion?: number;
  // САМОПРОВЕРКА КЭШЕЙ Z-РОУТЕРА (эпик render-scale): каждое попадание в кэш (повторный
  // круг портов в buildAutoRoutes, раздача компоненты, маршрут связи, пара маршрутов,
  // слот подписи) дополнительно считается честно и сверяется; расхождение — исключение с
  // названием кэша. Ставят corpus-check --selfcheck и тест zRoutesCache.
  __ARCHMAP_Z_SELFCHECK?: boolean;
}

export const diag = globalThis as typeof globalThis & ArchmapDiag;
