import { Fragment, useState } from "react";
import type { CSSProperties } from "react";
import { CopyFailed, copyText } from "../../lib/copyText";
import type { PersonalTokenCreated } from "../../types";
import DialogTitle from "../../ui/DialogTitle";
import Modal from "../../ui/Modal";
import { primaryBtn } from "../../ui/styles";

/**
 * Вид «токен выпущен» окна «Токены для MCP»: секрет показывается ОДИН раз — здесь, с
 * готовой строкой подключения. Строки общие, без привязки к клиенту: CLI — `mcp add`
 * в синтаксисе Claude Code, Qwen Code, Gemini CLI, Copilot CLI (имя программы — заглушка
 * <cli>); Desktop — блок mcpServers с url и headers, де-факто общий формат mcp.json.
 * Особые форматы (VS Code, httpUrl у Qwen Code) — в mcp/README.md. Адрес — origin
 * страницы + /mcp: тот же ArchMap, что открыт в браузере (в dev /mcp проксирует Vite).
 */

interface Props {
  issued: PersonalTokenCreated;
  onDone: () => void;
}

type Client = "cli" | "desktop";

// Заглушка имени программы в команде CLI: её пользователь меняет на свою.
const CLI_STUB = "<cli>";

const CLIENTS: { id: Client; label: string; hint: string }[] = [
  { id: "cli", label: "CLI", hint: `Вместо ${CLI_STUB} — claude, qwen, gigacode…` },
  { id: "desktop", label: "Desktop", hint: "В файл настроек MCP приложения" },
];

export default function IssuedTokenView({ issued, onDone }: Props) {
  const [client, setClient] = useState<Client>("cli");
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const url = `${window.location.origin}/mcp`;
  const { secret } = issued;
  const cliArgs = `mcp add --transport http archmap ${url} --header "Authorization: Bearer ${secret}"`;
  const connect: Record<Client, string> = {
    cli: `${CLI_STUB} ${cliArgs}`,
    desktop: JSON.stringify(
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
      <DialogTitle lead="Токен будет показан только один раз. Скопируйте его сейчас.">Токен выпущен</DialogTitle>

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
        <pre style={code} data-testid={`issued-${client}`}>
          {client === "cli" ? <><span style={stub}>{CLI_STUB}</span> {cliWords(cliArgs)}</> : connect[client]}
        </pre>
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
  // Перенос по пробелам, длинный токен — где придётся (break-all рвал и «--header»).
  whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "all",
};
// Опции «--header» и «--transport» не рвём на «--» и имя: браузер переносит после дефиса.
// Только показ — копируется строка connect.cli как есть.
function cliWords(text: string) {
  return text.split(" ").map((w, i) => (
    <Fragment key={i}>
      {i > 0 && " "}
      {w.startsWith("--") ? <span style={{ whiteSpace: "nowrap" }}>{w}</span> : w}
    </Fragment>
  ));
}

const stub: CSSProperties = { color: "#2563eb", fontWeight: 600 };
const note: CSSProperties = { margin: "10px 0 0", fontSize: 13, color: "#64748b" };
