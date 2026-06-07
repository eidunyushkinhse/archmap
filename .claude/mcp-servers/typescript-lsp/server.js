#!/usr/bin/env node
/**
 * MCP-сервер для TypeScript LSP (typescript-language-server).
 * Инструменты: ts_diagnostics, ts_definition, ts_references, ts_hover.
 * Переменная окружения: PROJECT_ROOT (корень проекта, по умолчанию — текущая директория).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";
import { readFileSync, existsSync } from "fs";
import { pathToFileURL } from "url";
import { resolve } from "path";

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();

/** Клиент для общения с typescript-language-server через JSON-RPC/stdio */
class TsLspClient {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.diagQueues = new Map(); // uri -> { queue: [], resolve?: fn }
    this.buf = Buffer.alloc(0);
    this.openFiles = new Set();
  }

  async start(root) {
    const tsServerBin = this._findBin("typescript-language-server");
    this.proc = spawn(tsServerBin, ["--stdio"], {
      cwd: root,
      stdio: ["pipe", "pipe", "ignore"],
      env: { ...process.env, NODE_OPTIONS: "" },
    });

    this.proc.stdout.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this._processBuffer();
    });

    this.proc.on("error", (err) => {
      console.error("typescript-language-server error:", err.message);
    });

    await this._initialize(root);
  }

  _findBin(name) {
    // Ищем в PATH через spawn — если не найдём, бросим ошибку при старте
    const candidates = [
      name,
      resolve(PROJECT_ROOT, "node_modules", ".bin", name),
      resolve(PROJECT_ROOT, "frontend", "node_modules", ".bin", name),
    ];
    for (const c of candidates) {
      try {
        if (existsSync(c)) return c;
      } catch {}
    }
    return name; // пусть ОС сама ищет в PATH
  }

  _processBuffer() {
    while (true) {
      const text = this.buf.toString("ascii");
      const match = text.match(/Content-Length: (\d+)\r\n\r\n/);
      if (!match) break;
      const headerEnd = this.buf.indexOf("\r\n\r\n") + 4;
      const length = parseInt(match[1], 10);
      if (this.buf.length < headerEnd + length) break;
      const body = this.buf.slice(headerEnd, headerEnd + length).toString("utf-8");
      this.buf = this.buf.slice(headerEnd + length);
      this._handleMessage(JSON.parse(body));
    }
  }

  _handleMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || "LSP error"));
      else resolve(msg.result);
    } else if (msg.method === "textDocument/publishDiagnostics") {
      const uri = msg.params.uri;
      if (this.diagQueues.has(uri)) {
        const entry = this.diagQueues.get(uri);
        if (entry.resolve) {
          const fn = entry.resolve;
          entry.resolve = null;
          fn(msg.params.diagnostics);
        } else {
          entry.queue.push(msg.params.diagnostics);
        }
      }
    }
  }

  _write(msg) {
    const body = Buffer.from(JSON.stringify(msg), "utf-8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  _request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this._write({ jsonrpc: "2.0", id, method, params });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, 15000);
    });
  }

  _notify(method, params) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  async _initialize(root) {
    const rootUri = pathToFileURL(resolve(root)).href;
    await this._request("initialize", {
      processId: null,
      rootUri,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["plaintext", "markdown"] },
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          publishDiagnostics: { dynamicRegistration: false },
        },
      },
      initializationOptions: { tsserver: { logVerbosity: "off" } },
    });
    this._notify("initialized", {});
  }

  async _open(filePath) {
    const uri = pathToFileURL(resolve(filePath)).href;
    if (this.openFiles.has(uri)) return;
    const text = readFileSync(filePath, "utf-8");
    const ext = filePath.endsWith(".tsx") ? "typescriptreact" : "typescript";
    this._notify("textDocument/didOpen", {
      textDocument: { uri, languageId: ext, version: 1, text },
    });
    this.openFiles.add(uri);
  }

  async _close(filePath) {
    const uri = pathToFileURL(resolve(filePath)).href;
    if (!this.openFiles.has(uri)) return;
    this._notify("textDocument/didClose", { textDocument: { uri } });
    this.openFiles.delete(uri);
  }

  async diagnostics(filePath) {
    const uri = pathToFileURL(resolve(filePath)).href;
    const entry = { queue: [], resolve: null };
    this.diagQueues.set(uri, entry);

    await this._open(filePath);

    const diags = await new Promise((resolve) => {
      // Может уже пришло до того, как мы поставили resolve
      if (entry.queue.length > 0) {
        resolve(entry.queue.shift());
        return;
      }
      entry.resolve = resolve;
      setTimeout(() => resolve([]), 10000);
    });

    this.diagQueues.delete(uri);
    await this._close(filePath);
    return diags;
  }

  async definition(filePath, line, character) {
    const uri = pathToFileURL(resolve(filePath)).href;
    await this._open(filePath);
    const result = await this._request("textDocument/definition", {
      textDocument: { uri },
      position: { line, character },
    });
    await this._close(filePath);
    return result;
  }

  async references(filePath, line, character) {
    const uri = pathToFileURL(resolve(filePath)).href;
    await this._open(filePath);
    const result = await this._request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: false },
    });
    await this._close(filePath);
    return result;
  }

  async hover(filePath, line, character) {
    const uri = pathToFileURL(resolve(filePath)).href;
    await this._open(filePath);
    const result = await this._request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    });
    await this._close(filePath);
    return result;
  }
}

function fmtLocation(loc) {
  const path = loc.uri.replace(/^file:\/\//, "");
  const { line, character } = loc.range.start;
  return `${path}:${line + 1}:${character + 1}`;
}

function fmtDiagnostic(d) {
  const { line } = d.range.start;
  const sev = { 1: "error", 2: "warning", 3: "info", 4: "hint" }[d.severity] ?? "error";
  const src = d.source ? `[${d.source}] ` : "";
  const code = d.code ? ` (${d.code})` : "";
  return `  ${sev} ${src}line ${line + 1}${code}: ${d.message}`;
}

function extractHoverText(result) {
  if (!result || !result.contents) return "Информация недоступна.";
  const c = result.contents;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x.value)).join("\n");
  if (typeof c === "object") return c.value ?? JSON.stringify(c);
  return String(c);
}

// Инициализация
let lsp = null;

async function getLsp() {
  if (!lsp) {
    lsp = new TsLspClient();
    await lsp.start(PROJECT_ROOT);
  }
  return lsp;
}

// MCP сервер
const server = new Server(
  { name: "typescript-lsp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ts_diagnostics",
      description: "Ошибки типов и синтаксиса в TypeScript/TSX-файле.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Абсолютный путь к .ts/.tsx файлу" },
        },
        required: ["file_path"],
      },
    },
    {
      name: "ts_definition",
      description:
        "Где определён символ в позиции (line, character). Возвращает путь и строку без чтения файлов. Строки и символы считаются с 0.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Абсолютный путь к .ts/.tsx файлу" },
          line: { type: "integer", description: "Номер строки (с 0)" },
          character: { type: "integer", description: "Позиция символа (с 0)" },
        },
        required: ["file_path", "line", "character"],
      },
    },
    {
      name: "ts_references",
      description:
        "Все места использования символа в позиции (line, character). Возвращает список файл:строка без чтения файлов.",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Абсолютный путь к .ts/.tsx файлу" },
          line: { type: "integer", description: "Номер строки (с 0)" },
          character: { type: "integer", description: "Позиция символа (с 0)" },
        },
        required: ["file_path", "line", "character"],
      },
    },
    {
      name: "ts_hover",
      description: "Тип и документация символа в позиции (line, character).",
      inputSchema: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Абсолютный путь к .ts/.tsx файлу" },
          line: { type: "integer", description: "Номер строки (с 0)" },
          character: { type: "integer", description: "Позиция символа (с 0)" },
        },
        required: ["file_path", "line", "character"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  let text;

  try {
    const client = await getLsp();
    const filePath = args.file_path;

    if (name === "ts_diagnostics") {
      const diags = await client.diagnostics(filePath);
      if (!diags || diags.length === 0) {
        text = "Ошибок не найдено.";
      } else {
        text = `Найдено ${diags.length} проблем в ${filePath}:\n` + diags.map(fmtDiagnostic).join("\n");
      }
    } else if (name === "ts_definition") {
      const result = await client.definition(filePath, args.line, args.character);
      if (!result || (Array.isArray(result) && result.length === 0)) {
        text = "Определение не найдено.";
      } else {
        const locs = Array.isArray(result) ? result : [result];
        text = locs.map(fmtLocation).join("\n");
      }
    } else if (name === "ts_references") {
      const result = await client.references(filePath, args.line, args.character);
      if (!result || result.length === 0) {
        text = "Использований не найдено.";
      } else {
        text = `Найдено ${result.length} использований:\n` + result.map(fmtLocation).join("\n");
      }
    } else if (name === "ts_hover") {
      const result = await client.hover(filePath, args.line, args.character);
      text = extractHoverText(result);
    } else {
      text = `Неизвестный инструмент: ${name}`;
    }
  } catch (err) {
    text = `Ошибка: ${err.message}`;
  }

  return { content: [{ type: "text", text }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
