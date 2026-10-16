// Папки пакета: содержимое, тема, сборка, данные сервера (ключ сессий).
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONTENT_DIR = join(PKG_DIR, "content");
export const THEME_DIR = join(PKG_DIR, "theme");
export const DIST_DIR = join(PKG_DIR, "dist");
export const DATA_DIR = join(PKG_DIR, ".data");
