import { useState } from "react";
import { CopyFailed, copyText } from "../../lib/copyText";
import type { PersonalTokenCreated } from "../../types";
import Modal from "../../ui/Modal";
import { CloseIcon } from "../../ui/icons";
import { CI_TABS, ciSnippet } from "./ciSignal";
import "../../ui/ds.css";
import "./userDialogs.css";

/**
 * Вид «токен выпущен» окна «Токены для MCP»: секрет показывается ОДИН раз — здесь, с
 * готовой строкой подключения. Строки общие, без привязки к клиенту: CLI — `mcp add`
 * в синтаксисе Claude Code, Qwen Code, Gemini CLI, Copilot CLI (имя программы — заглушка
 * <cli>); Desktop — блок mcpServers с url и headers, де-факто общий формат mcp.json.
 * Особые форматы (VS Code, httpUrl у Qwen Code) — в mcp/README.md. Адрес — origin
 * страницы + /mcp: тот же ArchMap, что открыт в браузере (в dev /mcp проксирует Vite).
 * У токена «только сигнал CI» вместо подключения агента — готовые строки CI (ciSignal.ts).
 *
 * Вид (редизайн, фаза 9д): каркас окна нового языка (ui/ds.css, ds-win). Секрет — блок
 * кода в одну строку (длинный переносится по символам) с «Скопировать» справа; блок
 * подключения — заголовок, вкладки-текст ds-tabs, пояснение вкладки с «Скопировать» в
 * одном ряду и блок кода того же вида, длинные строки которого прокручиваются внутри него
 * (users/userDialogs.css). В подвале одна «Готово».
 */

interface Props {
  issued: PersonalTokenCreated;
  onDone: () => void;
}

type Client = "cli" | "desktop";

// Заглушка имени программы в команде CLI: её пользователь меняет на свою.
const CLI_STUB = "<cli>";

const CLIENTS: { id: Client; label: string; hint: string }[] = [
  { id: "cli", label: "CLI", hint: `Вместо ${CLI_STUB} подставьте свою программу, например claude, qwen или gigacode` },
  { id: "desktop", label: "Desktop", hint: "В файл настроек MCP приложения" },
];

// Вкладка окна: подключение агента (CLI, Desktop) или строки CI (GitLab, GitHub, curl).
interface View {
  id: string;
  label: string;
  hint: string;
  text: string;
}

export default function IssuedTokenView({ issued, onDone }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const url = `${window.location.origin}/mcp`;
  const { secret } = issued;
  const ci = issued.token.ci_only;
  const cliArgs = `mcp add --transport http archmap ${url} --header "Authorization: Bearer ${secret}"`;
  const connect: Record<Client, string> = {
    cli: `${CLI_STUB} ${cliArgs}`,
    desktop: JSON.stringify(
      { mcpServers: { archmap: { url, headers: { Authorization: `Bearer ${secret}` } } } },
      null,
      2,
    ),
  };
  const views: View[] = ci
    ? CI_TABS.map((t) => ({ ...t, text: ciSnippet(t.id, window.location.origin) }))
    : CLIENTS.map((c) => ({ ...c, text: connect[c.id] }));
  const [tab, setTab] = useState(views[0].id);
  const view = views.find((v) => v.id === tab) ?? views[0];

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
    <button type="button" className="ds-btn" onClick={() => void copy(key, text)}>
      {copied === key ? "Скопировано" : "Скопировать"}
    </button>
  );

  return (
    <Modal onClose={onDone} closeButton={false} boxStyle={{ width: 600, padding: 0 }}>
      <div className="ds ds-win">
        <div className="ds-win-head">
          <h2 className="ds-win-title">Токен выпущен</h2>
          <button type="button" className="ds-icon-btn ds-win-close" aria-label="Закрыть" onClick={onDone}>
            <CloseIcon />
          </button>
        </div>

        <div className="ds-win-body">
          <p className="ud-lead">Токен будет показан только один раз. Скопируйте его сейчас.</p>
          <div className="ud-code-row">
            <code className="ud-code ud-secret" data-testid="issued-secret">{secret}</code>
            {copyButton("secret", secret)}
          </div>

          <section className="ds-win-block ud-connect">
            <h3 className="ds-win-block-title">{ci ? "Сигнал из CI после слияния в main" : "Подключение"}</h3>
            <div role="tablist" aria-label={ci ? "CI" : "Клиент"} className="ds-tabs">
              {views.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="tab"
                  aria-selected={view.id === v.id}
                  className={"ds-tab" + (view.id === v.id ? " is-active" : "")}
                  onClick={() => setTab(v.id)}
                >
                  {v.label}
                </button>
              ))}
            </div>
            <div className="ud-code-row">
              <span className="ud-code-hint">{view.hint}</span>
              {copyButton(view.id, view.text)}
            </div>
            <pre className="ud-code ud-pre" data-testid={`issued-${view.id}`}>
              {view.id === "cli" ? <><span className="ud-stub">{CLI_STUB}</span> {cliArgs}</> : view.text}
            </pre>
          </section>
          {copyError && <p className="ds-warn ud-flat">Браузер не дал скопировать. Выделите текст и скопируйте вручную.</p>}
        </div>

        <div className="ds-win-foot">
          <button type="button" data-autofocus className="ds-btn ds-btn--primary" onClick={onDone}>Готово</button>
        </div>
      </div>
    </Modal>
  );
}
