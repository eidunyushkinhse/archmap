// Воркер конвейера раскладки (Ф3 эпика плавности): исполняет ТОТ ЖЕ чистый модуль
// computeViewLayout вне главного потока. Никакой своей логики — только транспорт:
// вход/выход структурно-клонируемы (Map/Set поддерживаются, колбэков в
// PipelineInput/PipelineOutput нет). Идентичность результата гарантирована
// тождеством модуля (дамп-гейт эпика).
//
// ХАК ОКРУЖЕНИЯ (обязателен): elk.bundled внутри решает по `typeof document`,
// кем быть его забандленному elk-worker.min.js — «библиотекой» (экспортирует
// синхронный фейк-Worker; так он живёт на главном треде) или «воркер-скриптом»
// (вешает свой onmessage на self и НИЧЕГО не экспортирует). В среде Web Worker
// document отсутствует → фабрика elk получала undefined → «_Worker is not a
// constructor» на каждый прогон. Пустой document уводит elk в ветку «библиотека»
// — синхронная эмуляция в нашем воркере, ровно как на главном треде; сам код elk
// document не трогает (его штатная среда — воркер без DOM). Импорт конвейера —
// ДИНАМИЧЕСКИЙ: статические импорты хойстятся и исполнили бы elk до хака.
(self as unknown as { document?: object }).document ??= {};

const pipelinePromise = import("./pipeline");

interface WorkerRequest {
  runId: number;
  input: import("./pipeline").PipelineInput;
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { runId, input } = ev.data;
  void pipelinePromise
    .then(({ computeViewLayout }) => computeViewLayout(input))
    .then((out) => {
      self.postMessage({ runId, ok: true as const, out });
    })
    .catch((e: unknown) => {
      // законная ошибка конвейера: отдать наверх текстом (Error со стеком между
      // агентами не клонируем — сериализуем сообщение)
      self.postMessage({ runId, ok: false as const, error: e instanceof Error ? e.message : String(e) });
    });
};
