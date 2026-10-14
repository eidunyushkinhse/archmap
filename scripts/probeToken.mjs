// Токен зонда полигона (аудит P-6, P-23) — один на все зонды.
// Роль из токена ArchMap не читает: её решает база (админ — владелец любого проекта,
// участник — своя роль). Прежние зонды чеканили {'sub': 'admin', 'role': 'viewer'} — и
// «читатель» молча ходил с правами владельца: засев раскладки писался в dev-базу, а
// полигон «финал == перезагрузка» проверял не то. Теперь:
//  - architect — учётка ARCHMAP_PROBE_USER (по умолчанию admin);
//  - viewer — ОТДЕЛЬНАЯ учётка-читатель ARCHMAP_PROBE_READER (заводит
//    scripts/probe-reader.py); без неё зонд отказывается, а не пишет в базу.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Корень репозитория — от расположения модуля, а не от текущего каталога: Settings
// бэкенда читает .env из backend/, и зонд, запущенный из корня, иначе его не находил.
const BACKEND_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "backend");

export function probeUser(role) {
  if (role !== "viewer") return process.env.ARCHMAP_PROBE_USER ?? "admin";
  const reader = process.env.ARCHMAP_PROBE_READER;
  if (!reader) {
    console.error(
      "Режим читателя: нужна учётка-читатель. Один раз: backend/venv/bin/python scripts/probe-reader.py,\n" +
        "затем export ARCHMAP_PROBE_READER=probe-reader (иначе зонд писал бы в базу с правами владельца).",
    );
    process.exit(2);
  }
  return reader;
}

// JWT пишет python в файл (в stdout токен не печатаем); имя — аргументом, не в код.
export function makeToken(role) {
  const username = probeUser(role);
  const file = join(tmpdir(), `archmap-probe-tok-${process.pid}-${Date.now()}.txt`);
  execFileSync(join(BACKEND_DIR, "venv/bin/python"), ["-c", `
import sys; sys.path.insert(0, '.')
from app.auth import create_access_token
open(sys.argv[1], 'w').write(create_access_token({'sub': sys.argv[2]}))
`, file, username], { cwd: BACKEND_DIR });
  const token = readFileSync(file, "utf8").trim();
  rmSync(file);
  return token;
}
