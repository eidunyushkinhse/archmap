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
//
// ПАМЯТЬ СЦЕН (эпик render-scale, P11): воркер держит последние авторитетные результаты
// стадий стрелок по routeSig и отдаёт их конвейеру окружением прогона — повторное
// раскрытие и возврат на виденное состояние не считают стрелки заново. Память живёт, пока
// жив воркер; свежий воркер после обрыва клиент засевает своим зеркалом памяти
// ({ kind: "seed" }). Модуль памяти ELK не тянет — статический импорт хаку не мешает.
//
// ПРОГРЕВ (эпик render-scale): сообщение { kind: "warm" } грузит конвейер и ELK заранее —
// клиент шлёт его, когда оболочка проекта открылась, ещё до данных холста. Прогреву
// ничего не надо возвращать; настоящий прогон, пришедший раньше, чем ELK загрузился, ждёт
// тот же промис загрузки, а не второй.
import { createRouteMemory } from "./routeMemory";
import type { WorkerRequest } from "./pipelineClient";

(self as unknown as { document?: object }).document ??= {};

const pipelinePromise = import("./pipeline");
const routeMemory = createRouteMemory();

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.kind === "seed") {
    // засев памяти сцен после обрыва прежнего воркера (зеркало клиента, от давней к свежей)
    for (const [sig, entry] of msg.entries) routeMemory.put(sig, entry);
    return;
  }
  if (msg.kind === "warm") {
    void pipelinePromise
      .then(() => import("./engine"))
      .then(({ getElk }) => getElk())
      .catch(() => { /* прогрев — оптимизация: сбой проявится в первом прогоне */ });
    return;
  }
  const { runId, input } = msg;
  void pipelinePromise
    .then(({ computeViewLayout }) => computeViewLayout(input, { routeMemory }))
    .then((out) => {
      self.postMessage({ runId, ok: true as const, out });
    })
    .catch((e: unknown) => {
      // законная ошибка конвейера: отдать наверх текстом (Error со стеком между
      // агентами не клонируем — сериализуем сообщение)
      self.postMessage({ runId, ok: false as const, error: e instanceof Error ? e.message : String(e) });
    });
};
