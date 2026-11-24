// «Ответы агента» в окне «Описать схемы логики с помощью ИИ-агента»: общая зона пакета
// окон дозаливки от агента (AgentFiles). Здесь только своё у этого окна: текст зоны по
// режиму и уборка отчёта вместе с последним файлом (useDocsAgent.removeFile).
import type { DocsAgent } from "./useDocsAgent";
import AgentFiles from "./AgentFiles";

export default function DocsAgentFiles({ agent, single, over, dropError }: {
  agent: DocsAgent;
  // «По одной схеме»: агент отдаёт один файл.
  single: boolean;
  // Над окном тащат файлы: зона подсвечена.
  over: boolean;
  // Что из перетащенного не взято и почему.
  dropError: string | null;
}) {
  return (
    <AgentFiles
      pkg={agent.pkg}
      text={single ? "Перетащите сюда файл схемы от агента" : "Перетащите сюда файлы схем от агента"}
      over={over}
      dropError={dropError}
      onRemove={agent.removeFile}
      autofill="docs-agent-paste"
    />
  );
}
