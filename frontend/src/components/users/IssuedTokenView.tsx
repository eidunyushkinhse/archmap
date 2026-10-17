import { useState } from "react";
import type { CSSProperties } from "react";
import { CopyFailed, copyText } from "../../lib/copyText";
import type { PersonalTokenCreated } from "../../types";
import DialogTitle from "../../ui/DialogTitle";
import Modal from "../../ui/Modal";
import { primaryBtn } from "../../ui/styles";

/**
 * Вид «токен выпущен» окна «Токены для агентов»: секрет показывается ОДИН раз — здесь, с
 * готовыми строками подключения. Адрес — origin страницы + /mcp: тот же ArchMap, что
 * открыт в браузере (в dev /mcp проксирует Vite).
 */

interface Props {
  issued: PersonalTokenCreated;
  onDone: () => void;
}

export default function IssuedTokenView({ issued, onDone }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const url = `${window.location.origin}/mcp`;
  const { secret, token } = issued;
  const command = `claude mcp add --transport http archmap ${url} --header "Authorization: Bearer ${secret}"`;
  const json = JSON.stringify(
    { mcpServers: { archmap: { type: "http", url, headers: { Authorization: `Bearer ${secret}` } } } },
    null,
    2,
  );

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

  const block = (key: string, label: string, text: string) => (
    <div style={{ marginBottom: 14 }}>
      <div style={blockHead}>
        <span style={blockLabel}>{label}</span>
        <button style={copyBtn} onClick={() => void copy(key, text)}>
          {copied === key ? "Скопировано" : "Скопировать"}
        </button>
      </div>
      <pre style={code} data-testid={`issued-${key}`}>{text}</pre>
    </div>
  );

  return (
    <Modal onClose={onDone} boxStyle={{ width: 600, padding: 24, maxHeight: "86vh", overflowY: "auto" }}>
      <DialogTitle lead="Скопируйте сейчас — потом токен не показать. Не кладите его в файлы, которые попадают в git.">
        Токен «{token.name}» выпущен
      </DialogTitle>
      {token.read_only && <p style={note}>Только чтение: агент сможет смотреть, но не менять.</p>}
      {block("secret", "Токен", secret)}
      {block("claude", "Claude Code — команда в терминале", command)}
      {block("json", "Cursor и другие клиенты — mcp.json", json)}
      {copyError && <p style={note}>Браузер не дал скопировать — выделите текст и скопируйте вручную.</p>}
      <div style={{ display: "flex", marginTop: 6 }}>
        <button data-autofocus style={primaryBtn} onClick={onDone}>Готово</button>
      </div>
    </Modal>
  );
}

const blockHead: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 };
const blockLabel: CSSProperties = { fontSize: 13, fontWeight: 600, color: "#475569" };
const copyBtn: CSSProperties = {
  background: "none", border: "none", padding: "2px 2px", fontSize: 13, fontWeight: 600,
  color: "#2563eb", cursor: "pointer",
};
const code: CSSProperties = {
  margin: 0, padding: "10px 12px", border: "1px solid #e2e8f0", borderRadius: 8, background: "#f8fafc",
  fontSize: 12.5, lineHeight: 1.5, color: "#0f172a", whiteSpace: "pre-wrap", wordBreak: "break-all",
  userSelect: "all",
};
const note: CSSProperties = { margin: "0 0 12px", fontSize: 13, color: "#64748b" };
