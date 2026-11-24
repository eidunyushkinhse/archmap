// Окно спеки (режим OpenAPI DocOverlay) — тот же порядок, что у схемы логики
// (вьюер v2, docs/tasks/doc-viewer-v2.md):
//   • просмотр — Swagger-рендер без кода; архитектору «Изменить ▾» (Вручную |
//     Через ИИ-агента), наблюдателю «Показать код»;
//   • «Вручную» — YAML-редактор с превью, подвал на всю ширину окна: «Сохранить»,
//     «Отмена»; отказ — строкой над кнопками. Правило черновика прежнее: невалидная
//     спека сохраняется, превью держит последнюю корректную версию до исправления;
//   • «Через ИИ-агента» — малое окно семьи окон агента (DocAgentStage): задание агенту,
//     ответы агента и отчёт, подвал «Применить», «Отмена»; после «Применить» окно
//     перечитывает спеку и возвращается к чтению.
// Пишет спеку страница (onCommitOpenapi → PATCH узла под CAS): окно только ждёт
// ответа, чтобы показать в просмотре то, что действительно сохранено.
// Все стадии на новом языке: шапка и чтение (редизайн, фаза 7а) — имя объекта, «OpenAPI»,
// справа «Изменить» или «Показать код»; «Вручную» (фаза 7б) — в шапке только имя объекта,
// название и крестик; «Через ИИ-агента» (фаза 7в).
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { PromptVariant } from "../../types";
import { nodesApi } from "../../api/nodes";
import { docsImportApi } from "../../api/docsImport";
import OpenApiDoc from "./OpenApiDoc";
import { SpecAgentStage } from "./DocAgentStage";
import { CodeToggle, DocHead, EditMenu } from "./docChrome";
import { limitMessage } from "../demo/demoLimits";
import type { LimitMessage } from "../demo/demoLimits";
import { LimitText } from "../demo/DemoLimitToast";
import { copyText } from "../../lib/copyText";
import "../../ui/ds.css";
import "./docOverlay.css";

export type DocStage = "view" | "manual" | "agent";

interface Props {
  nodeId: string;
  nodeName: string;
  openapi: string; // сохранённая спека узла (сырой текст, пусто — нет)
  isArchitect: boolean;
  // Записать спеку. true — сохранено; false — нет (конфликт версий: страница уже
  // подтянула свежее и показывает notice).
  onCommitOpenapi: (value: string) => Promise<boolean>;
  // Конфликт конкурентных сессий от страницы — строкой под шапкой.
  notice?: string | null;
  onClose: () => void;
  // Крестик шапки: окно само решит, спросить ли «Закрыть без сохранения?».
  onRequestClose?: () => void;
  // Есть ли несохранённая правка «Вручную» — окно читает при закрытии.
  dirtyRef?: { current: boolean };
  // С чего открыть: «+ Добавить → Вручную / Через ИИ-агента» на странице.
  initialStage?: DocStage;
  // Пакет агента записан — страница освежает мету узла.
  onApplied?: () => void;
}

export default function OpenApiPane({
  nodeId, nodeName, openapi, isArchitect, onCommitOpenapi, notice, onClose, onRequestClose, dirtyRef, initialStage, onApplied,
}: Props) {
  const [stage, setStage] = useState<DocStage>(isArchitect ? initialStage ?? "view" : "view");
  // Спека, которую показывает окно. Страница присылает сохранённую (openapi), но
  // окно знает свежее раньше: своё «Сохранить» и перечитывание после агента.
  // Пропс сверяем при рендере (паттерн «adjusting state when props change»), а не
  // эффектом-зеркалом: сменился — берём его.
  const [spec, setSpec] = useState(openapi);
  const [seenProp, setSeenProp] = useState(openapi);
  // Ремаунт рендера/редактора на смену показанной спеки: OpenApiDoc читает текст
  // только при маунте.
  const [rev, setRev] = useState(0);
  if (openapi !== seenProp) {
    setSeenProp(openapi);
    if (openapi !== spec) {
      setSpec(openapi);
      setRev((r) => r + 1);
    }
  }
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Демо-стенд: сохранение упёрлось в предел — строкой над кнопками подвала, черновик цел.
  const [limit, setLimit] = useState<LimitMessage | null>(null);
  const [showCode, setShowCode] = useState(false); // наблюдатель: «Показать код»

  const hasSpec = spec.trim() !== "";
  // Несохранённая правка «Вручную» — окну нужна только при закрытии (реф).
  const dirty = stage === "manual" && draft !== null && draft !== spec;
  useEffect(() => { if (dirtyRef) dirtyRef.current = dirty; }, [dirty, dirtyRef]);

  function show(text: string) {
    setSpec(text);
    setRev((r) => r + 1);
  }

  function toView() {
    setStage("view");
    setDraft(null);
    setLimit(null);
  }

  // Спеки ещё нет — показывать нечего: выход из правки закрывает окно.
  function leave() {
    if (hasSpec) toView();
    else onClose();
  }

  async function save() {
    if (saving) return;
    const value = draft ?? spec;
    if (value === spec) {
      leave();
      return;
    }
    setSaving(true);
    setLimit(null);
    let ok = false;
    try {
      ok = await onCommitOpenapi(value);
    } catch (e: unknown) {
      // Отказ по пределу демо-стенда страница пробрасывает сюда: правка остаётся в
      // редакторе, её можно сократить и сохранить снова. Прочее — как раньше.
      const refusal = limitMessage(e, "save");
      if (refusal) {
        setSaving(false);
        setLimit(refusal);
        return;
      }
    }
    setSaving(false);
    if (ok) {
      show(value);
      toView();
    } else {
      // Конфликт: страница подтянула свежее (пропс openapi) и показала notice;
      // окно возвращается к просмотру свежего, как у схем логики.
      toView();
    }
  }

  function copyPrompt(variant: PromptVariant): Promise<void> {
    return copyText(docsImportApi
      .prompt({ nodeId, include: "api", lang: "ru", hints: "", variant })
      .then(({ prompt }) => prompt));
  }

  async function afterAgent() {
    onApplied?.();
    try {
      const fresh = await nodesApi.get(nodeId);
      show(fresh.openapi_spec ?? "");
    } catch { /* страница догонит поллингом */ }
    toView();
  }

  // «Через ИИ-агента» — своё малое окно целиком: шапка, тело и подвал стадии. «Отмена»
  // возвращает к чтению, а если спецификации ещё нет — закрывает окно.
  if (stage === "agent" && isArchitect) {
    return (
      <SpecAgentStage
        nodeId={nodeId}
        nodeName={nodeName}
        notice={notice}
        copy={copyPrompt}
        onClose={onRequestClose ?? onClose}
        onCancel={leave}
        onApplied={() => void afterAgent()}
      />
    );
  }

  // ── шапка ──
  // В правке в шапке только имя объекта, название и крестик: кнопки правки — в подвале.
  const editing = stage === "manual" && isArchitect;
  let actions: ReactNode = null;
  if (stage === "view" && isArchitect) {
    actions = <EditMenu label="Изменить" onManual={() => setStage("manual")} onAgent={() => setStage("agent")} />;
  } else if (!isArchitect && hasSpec) {
    actions = <CodeToggle shown={showCode} onToggle={() => setShowCode((s) => !s)} />;
  }

  // ── тело и подвал ──
  let body: ReactNode;
  let foot: ReactNode = null;
  if (editing) {
    body = (
      <OpenApiDoc
        key={`edit:${rev}`}
        initial={spec}
        isArchitect
        showCode
        onDraft={setDraft}
      />
    );
    // Подвал на всю ширину окна: «Сохранить», «Отмена»; отказ по пределу демо-стенда —
    // строкой над кнопками. Спецификацию с ошибкой по-прежнему можно сохранить: превью
    // держит последний текст без ошибок и говорит об этом строкой над собой.
    foot = (
      <div className="ds-win-foot doc-editfoot">
        {limit && <p className="ds-danger ds-win-err" role="alert"><LimitText message={limit} /></p>}
        <button type="button" className="ds-btn ds-btn--primary" onClick={() => void save()} disabled={saving}>
          Сохранить
        </button>
        <button type="button" className="ds-btn" onClick={leave}>Отмена</button>
      </div>
    );
  } else {
    body = (
      <OpenApiDoc
        key={`view:${rev}`}
        initial={spec}
        isArchitect={false}
        showCode={showCode}
      />
    );
  }

  return (
    <>
      <DocHead
        objectName={nodeName}
        title="OpenAPI"
        notice={notice}
        actions={actions}
        onClose={onRequestClose ?? onClose}
      />
      <div className="doc-body">{body}</div>
      {foot}
    </>
  );
}
