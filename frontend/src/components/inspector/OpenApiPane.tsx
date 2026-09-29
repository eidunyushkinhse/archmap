// Окно спеки (режим OpenAPI DocOverlay) — тот же порядок, что у схемы логики
// (вьюер v2, docs/tasks/doc-viewer-v2.md):
//   • просмотр — Swagger-рендер без кода; архитектору «Изменить ▾» (Вручную |
//     Через ИИ-агента), наблюдателю «Показать код»;
//   • «Вручную» — YAML-редактор с превью, «Отмена» и «Сохранить» в шапке. Правило
//     черновика прежнее: невалидная спека сохраняется, превью держит последнюю
//     корректную версию до исправления;
//   • «Через ИИ-агента» — шаги с промптом слева, панель пакета справа
//     (SpecAgentPanel); после «Применить» окно перечитывает спеку.
// Пишет спеку страница (onCommitOpenapi → PATCH узла под CAS): окно только ждёт
// ответа, чтобы показать в просмотре то, что действительно сохранено.
import { useState } from "react";
import type { ReactNode } from "react";
import type { PromptVariant } from "../../types";
import { nodesApi } from "../../api/nodes";
import { docsImportApi } from "../../api/docsImport";
import OpenApiDoc from "./OpenApiDoc";
import SpecAgentPanel from "../docsImport/SpecAgentPanel";
import { ApiGlyph, DocAgentSteps, DocHead, EditMenu } from "./docChrome";

export type DocStage = "view" | "manual" | "agent";

interface Props {
  nodeId: string;
  nodeName: string;
  openapi: string; // сохранённая спека узла (сырой текст, пусто — нет)
  isArchitect: boolean;
  // Записать спеку. true — сохранено; false — нет (конфликт версий: страница уже
  // подтянула свежее и показывает notice).
  onCommitOpenapi: (value: string) => Promise<boolean>;
  // Конфликт конкурентных сессий от страницы — плашкой в шапке.
  notice?: string | null;
  onClose: () => void;
  // С чего открыть: «+ Добавить → Вручную / Через ИИ-агента» на странице.
  initialStage?: DocStage;
  // Пакет агента записан — страница освежает мету узла.
  onApplied?: () => void;
}

// «3.0.3» → «3.0» для тега «OAS 3.0 · YAML»
function shortVersion(v: string): string {
  return v.split(".").slice(0, 2).join(".");
}

export default function OpenApiPane({
  nodeId, nodeName, openapi, isArchitect, onCommitOpenapi, notice, onClose, initialStage, onApplied,
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
  const [showCode, setShowCode] = useState(false); // наблюдатель: «Показать код»
  // Версия OAS из последнего валидного парса (шлёт OpenApiDoc) — для тега шапки.
  const [oasVersion, setOasVersion] = useState<string | undefined>(undefined);

  const hasSpec = spec.trim() !== "";

  function show(text: string) {
    setSpec(text);
    setRev((r) => r + 1);
  }

  function toView() {
    setStage("view");
    setDraft(null);
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
    const ok = await onCommitOpenapi(value).catch(() => false);
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
    return docsImportApi
      .prompt({ nodeId, include: "api", lang: "ru", hints: "", variant })
      .then(({ prompt }) => navigator.clipboard.writeText(prompt));
  }

  async function afterAgent() {
    onApplied?.();
    try {
      const fresh = await nodesApi.get(nodeId);
      show(fresh.openapi_spec ?? "");
    } catch { /* страница догонит поллингом */ }
    toView();
  }

  // ── шапка ──
  let actions: ReactNode = null;
  if (stage === "manual" && isArchitect) {
    actions = (
      <>
        <button type="button" className="doc-btn doc-btn--ghost" onClick={leave}>Отмена</button>
        <button type="button" className="doc-btn doc-btn--primary" onClick={() => void save()} disabled={saving}>
          Сохранить
        </button>
      </>
    );
  } else if (stage === "agent" && isArchitect) {
    actions = hasSpec ? <button type="button" className="doc-back" onClick={toView}>← К спецификации</button> : null;
  } else if (isArchitect) {
    actions = <EditMenu label="Изменить" onManual={() => setStage("manual")} onAgent={() => setStage("agent")} />;
  } else if (hasSpec) {
    actions = (
      <button type="button" className="doc-codebtn" onClick={() => setShowCode((s) => !s)}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3" />
        </svg>
        {showCode ? "Скрыть код" : "Показать код"}
      </button>
    );
  }

  // ── тело и подвал ──
  let body: ReactNode;
  let foot: string | null = null;
  if (stage === "manual" && isArchitect) {
    body = (
      <OpenApiDoc
        key={`edit:${rev}`}
        initial={spec}
        isArchitect
        showCode
        onDraft={setDraft}
        onVersion={setOasVersion}
      />
    );
    foot = "Невалидная спека сохраняется как черновик, рендер не обновляется до исправления";
  } else if (stage === "agent" && isArchitect) {
    body = (
      <div className="doc-agent">
        <div className="doc-agentleft">
          <DocAgentSteps service={nodeName} copy={copyPrompt} />
        </div>
        <div className="doc-agentright">
          <SpecAgentPanel nodeId={nodeId} onApplied={() => void afterAgent()} />
        </div>
      </div>
    );
    foot = "Спека не изменится, пока вы не нажмёте «Применить»";
  } else {
    body = (
      <OpenApiDoc
        key={`view:${rev}`}
        initial={spec}
        isArchitect={false}
        showCode={showCode}
        onVersion={setOasVersion}
      />
    );
  }

  return (
    <>
      <DocHead
        glyph={<ApiGlyph />}
        title={<>{nodeName} <span>· OpenAPI</span></>}
        tag={oasVersion ? `OAS ${shortVersion(oasVersion)} · YAML` : "OpenAPI · YAML"}
        tagOas
        notice={notice}
        actions={actions}
        onClose={onClose}
      />
      <div className="doc-body">{body}</div>
      {foot && <div className="doc-foot">{foot}</div>}
    </>
  );
}
