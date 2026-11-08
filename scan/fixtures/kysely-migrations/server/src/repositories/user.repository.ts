import { sql } from 'kysely';

// Запрос вне каталога migrations: таблиц не задаёт.
export const ghost = sql`CREATE TABLE "ghost" ("id" uuid)`;
