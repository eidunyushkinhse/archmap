// ФОНОВАЯ УБОРКА СКОУПНОЙ ГРЯЗИ ПО БЕЗДЕЙСТВИЮ (раунд 2 полевой находки приёмки №1
// эпика «глубокая оптимизация роутера», спека perf.md P14).
//
// ЗАЧЕМ. Скоупный прогон (E82/E84) кладёт живые рёбра ХУЖЕ полного: часть сцены — это
// замороженный preplaced-контекст, слоты его концов не передистрибутируются, а плашки
// чинятся по всей сцене. Дефекты такого прогона НАКАПЛИВАЮТСЯ — следующий скоупный
// наследует их через prevRoutes — и не самоизлечиваются до полного пересчёта. Плюс
// скоупный прогон не авторитетен и кэш вида (P11) не обновляет: следующее открытие
// вида считает сцену вхолодную. Уборка снимает обе цены разом: по паузе бездействия
// холст тихо досчитывает ПОЛНЫЙ прогон и подменяет им геометрию.
//
// ЗДЕСЬ — ТОЛЬКО ТАЙМЕР И УЧЁТ ГРЯЗИ (чистая логика под юнит-тест). Сам прогон,
// «последний выигрывает» и запись кэша остаются в LevelGraph: уборка — не отдельный
// путь, а ШТАТНЫЙ прогон без prev-полей (см. P14).
//
// ИНВАРИАНТЫ:
//  - грязь := true завершением СКОУПНОГО прогона; := false завершением АВТОРИТЕТНОГО
//    (он по определению полный и полноценный). Прочие прогоны (пропуск P10, частичные
//    замеры, ступень бюджета) грязь не трогают: они её не создали и не смыли;
//  - таймер взводится завершением прогона, ПОСЛЕ КОТОРОГО ГРЯЗЬ ОСТАЛАСЬ, и
//    перезаводится каждым следующим таким; снимается стартом ЛЮБОГО прогона (его
//    результат сам решит, нужна ли уборка) и размонтированием;
//  - ЖЕСТ ОТКЛАДЫВАЕТ, А НЕ ОТМЕНЯЕТ: сработавший в драге/анимационном окне таймер
//    перезаводится на ту же паузу — уборка дождётся тишины;
//  - ОДНА ПОПЫТКА: уборочный прогон не скоуплен (prev ему не дают), поэтому сам себя
//    он не перезаводит; а вышел не-авторитетным (ступень бюджета, незамеренные узлы) —
//    петли всё равно нет: грязь остаётся до следующего естественного полного прогона.
import { useCallback, useEffect, useMemo, useRef } from "react";

/** Пауза бездействия до фоновой уборки. Живой драг и анимации её откладывают. */
export const CLEANUP_IDLE_MS = 3000;

/** Исход завершившегося (не устаревшего) прогона конвейера. */
export interface CleanupRunResult {
  /** PipelineOutput.scoped — прогон реально скоуплен (E82/E84) */
  scoped: boolean;
  /** PipelineOutput.authoritative — полный полноценный прогон (P11) */
  authoritative: boolean;
  /** это был сам уборочный прогон (запущен этим хуком) */
  cleanup: boolean;
}

interface UseIdleCleanupArgs {
  /** запустить уборочный прогон — штатный прогон холста БЕЗ prev-полей */
  run: () => void;
  /** «занято»: драг в полёте или открыто тихое окно анимации — уборку отложить */
  isBusy: () => boolean;
  /** пауза бездействия; по умолчанию CLEANUP_IDLE_MS (ручка для тестов) */
  delayMs?: number;
}

export interface IdleCleanup {
  /** стартовал ЛЮБОЙ прогон конвейера — взведённый таймер снять */
  noteRunStarted: () => void;
  /** прогон ЗАВЕРШИЛСЯ и не устарел — обновить учёт грязи и переармировать таймер */
  noteRunFinished: (r: CleanupRunResult) => void;
}

export function useIdleCleanup({ run, isBusy, delayMs = CLEANUP_IDLE_MS }: UseIdleCleanupArgs): IdleCleanup {
  // Свежие ссылки на колбэки владельца: сам хук стабилен (пустые deps), а зовёт
  // всегда актуальные реализации — зеркалим эффектом (react-hooks/refs).
  const runRef = useRef(run);
  const busyRef = useRef(isBusy);
  const delayRef = useRef(delayMs);
  useEffect(() => {
    runRef.current = run;
    busyRef.current = isBusy;
    delayRef.current = delayMs;
  });

  const timerRef = useRef(0);
  // на экране лежит геометрия, часть которой — замороженный prev-контекст
  const dirtyRef = useRef(false);
  // уборка за этой грязью уже ходила и вернулась ни с чем — по кругу не гоняем
  const gaveUpRef = useRef(false);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = 0;
    }
  }, []);

  const arm = useCallback(() => {
    cancel();
    timerRef.current = window.setTimeout(function fire() {
      timerRef.current = 0;
      // Жест/анимация в полёте: уборка ждёт тишины (перезавод на ту же паузу).
      // Прогон в драге сжёг бы кадры жеста, а его результат всё равно перегнал бы
      // пересчёт по отпусканию.
      if (busyRef.current()) {
        timerRef.current = window.setTimeout(fire, delayRef.current);
        return;
      }
      if (!dirtyRef.current || gaveUpRef.current) return; // защёлка сменилась под таймером
      runRef.current();
    }, delayRef.current);
  }, [cancel]);

  const noteRunStarted = useCallback(() => { cancel(); }, [cancel]);

  const noteRunFinished = useCallback((r: CleanupRunResult) => {
    if (r.scoped) {
      // новая порция грязи — прежний отказ уборки к ней не относится
      dirtyRef.current = true;
      gaveUpRef.current = false;
    } else if (r.authoritative) {
      dirtyRef.current = false;
      gaveUpRef.current = false;
    }
    // Уборочный прогон, не ставший авторитетным (ступень бюджета P13, незамеренные
    // узлы, неполный состав), — единственная попытка: грязь дождётся следующего
    // естественного полного пересчёта («Переразложить», открытие вида).
    if (r.cleanup && !r.authoritative) gaveUpRef.current = true;
    if (dirtyRef.current && !gaveUpRef.current) arm();
    else cancel();
  }, [arm, cancel]);

  // Размонтирование: таймер уборки не переживает холст.
  useEffect(() => cancel, [cancel]);

  // Ссылочно СТАБИЛЬНЫЙ результат: его читает computeNow холста, а тот сидит в
  // useCallback, от identity которого зависит эффект раскладки — новый объект на
  // каждый рендер гонял бы конвейер по кругу.
  return useMemo(() => ({ noteRunStarted, noteRunFinished }), [noteRunStarted, noteRunFinished]);
}
