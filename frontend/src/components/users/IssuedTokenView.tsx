import { useState } from "react";
import type { CSSProperties } from "react";
import { CopyFailed, copyText } from "../../lib/copyText";
import type { PersonalTokenCreated } from "../../types";
import DialogTitle from "../../ui/DialogTitle";
import Modal from "../../ui/Modal";
import { primaryBtn } from "../../ui/styles";

/**
 * Вид «токен выпущен» окна «Токены для агентов»: секрет показывается ОДИН раз — здесь, с
 * готовой строкой подключения (вкладки Claude Code и Cursor; VS Code, Qwen Code и общий
 * .mcp.json — в mcp/README.md). Адрес — origin страницы + /mcp: тот же ArchMap, что
 * открыт в браузере (в dev /mcp проксирует Vite).
 */

interface Props {
  issued: PersonalTokenCreated;
  onDone: () => void;
}

type Client = "claude" | "cursor";

const CLIENTS: { id: Client; label: string; hint: string }[] = [
  { id: "claude", label: "Claude Code", hint: "Команда в терминале" },
  { id: "cursor", label: "Cursor", hint: "Файл ~/.cursor/mcp.json" },
];

export default function IssuedTokenView({ issued, onDone }: Props) {
  const [client, setClient] = useState<Client>("claude");
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const url = `${window.location.origin}/mcp`;
  const { secret } = issued;
  const connect: Record<Client, string> = {
    claude: `claude mcp add --transport http archmap ${url} --header "Authorization: Bearer ${secret}"`,
    cursor: JSON.stringify(
      { mcpServers: { archmap: { url, headers: { Authorization: `Bearer ${secret}` } } } },
      null,
      2,
    ),
  };

  async function copy(key: string, text: string) {
    setCopyError(false);
    try {
      await copyText(text);
      setCopied(key);
    } catch (e: unknown) {
      if (!(e instanceof CopyFailed)) throw e;
      setCopied(null);
      setCopyError(true);
    }
  }

  const copyButton = (key: string, text: string) => (
    <button style={copyBtn} onClick={() => void copy(key, text)}>
      {copied === key ? "Скопировано" : "Скопировать"}
    </button>
  );

  return (
    <Modal onClose={onDone} boxStyle={{ width: 600, padding: 24, maxHeight: "86vh", overflowY: "auto" }}>
      <DialogTitle lead="Скопируйте его сейчас — больше он показан не будет.">Токен выпущен</DialogTitle>

      <div style={tokenRow}>
        <code style={tokenText} data-testid="issued-secret">{secret}</code>
        {copyButton("secret", secret)}
      </div>

      <div style={connectHead}>
        <span style={sectionLabel}>Подключение</span>
        <div role="tablist" aria-label="Клиент" style={seg}>
          {CLIENTS.map((c) => (
            <button
              key={c.id}
              role="tab"
              aria-selected={client === c.id}
              style={segBtn(client === c.id)}
              onClick={() => setClient(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <div style={codeBox}>
        <div style={codeHead}>
          <span style={hint}>{CLIENTS.find((c) => c.id === client)?.hint}</span>
          {copyButton(client, connect[client])}
        </div>
        <pre style={code} data-testid={`issued-${client}`}>{connect[client]}</pre>
      </div>
      {copyError && <p style={note}>Браузер не дал скопировать — выделите текст и скопируйте вручную.</p>}

      <div style={{ display: "flex", marginTop: 20 }}>
        <button data-autofocus style={primaryBtn} onClick={onDone}>Готово</button>
      </div>
    </Modal>
  );
}

const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const tokenRow: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, padding: "8px 8px 8px 12px",
  border: "1px solid #e2e8f0", borderRadius: 8, background: "#f8fafc",
};
const tokenText: CSSProperties = {
  flex: 1, minWidth: 0, fontFamily: mono, fontSize: 12.5, lineHeight: 1.5, color: "#0f172a",
  wordBreak: "break-all", userSelect: "all",
};
const copyBtn: CSSProperties = {
  flex: "none", background: "none", border: "none", padding: "2px 4px", fontSize: 13, fontWeight: 600,
  color: "#2563eb", cursor: "pointer",
};
const connectHead: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", margin: "20px 0 8px",
};
const sectionLabel: CSSProperties = { fontSize: 13, fontWeight: 600, color: "#475569" };
// Переключатель — как «Как есть / Переход / Как будет» (.insp-seg--inline).
const seg: CSSProperties = { display: "inline-flex", gap: 2, padding: 2, background: "#eceef1", borderRadius: 8 };
const segBtn = (on: boolean): CSSProperties => ({
  padding: "4px 10px", border: "none", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
  background: on ? "#fff" : "none", color: on ? "#2563eb" : "#475569",
  boxShadow: on ? "0 1px 2px rgba(15,23,42,.12)" : "none",
  transition: "background .12s, color .12s, box-shadow .12s",
});
const codeBox: CSSProperties = { border: "1px solid #e2e8f0", borderRadius: 8, background: "#f8fafc" };
const codeHead: CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between",
  padding: "6px 8px 6px 12px", borderBottom: "1px solid #e2e8f0",
};
const hint: CSSProperties = { fontSize: 12.5, color: "#64748b" };
const code: CSSProperties = {
  margin: 0, padding: "10px 12px", fontFamily: mono, fontSize: 12.5, lineHeight: 1.5, color: "#0f172a",
  whiteSpace: "pre-wrap", wordBreak: "break-all", userSelect: "all",
};
const note: CSSProperties = { margin: "10px 0 0", fontSize: 13, color: "#64748b" };
