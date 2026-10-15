import type { OverlayStack } from "./useOverlayStack";
import type { ProcessDetailState } from "./useProcessDetail";
import type { ProcessHistory } from "./useProcessHistory";

// Контекст правок холста процесса (аудит F-2): модули правок (фрагменты, шаги,
// участники) получают процесс с каркасом мутации, историю и стек окон — и только их.
export interface ProcessEditCtx {
  id: string;
  proc: ProcessDetailState;
  hist: ProcessHistory;
  overlays: Pick<OverlayStack, "open" | "close" | "update">;
}
