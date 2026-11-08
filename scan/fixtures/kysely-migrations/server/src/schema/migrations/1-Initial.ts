import { Kysely, sql } from 'kysely';

const lastMigration = sql<{ name: string }>`SELECT "name" FROM "migrations" LIMIT 1`;
// sql`CREATE TABLE "commented" ("id" uuid)` в комментарии не читается.

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS ${sql.raw(extension)} CASCADE`.execute(db);
  await sql`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "status" character varying NOT NULL DEFAULT ${defaultStatus}, CONSTRAINT "users_pkey" PRIMARY KEY ("id"));`.execute(db);
  await sql`CREATE TABLE "smart_search" (
    "assetId" uuid NOT NULL REFERENCES "users" ("id"),
    "embedding" ${sql.raw(vectorType)}(512) NOT NULL
  );`.execute(db);
  await sql`INSERT INTO "users" ("email") VALUES ('a\`b')`.execute(db);
  await db.schema.alterTable('users').addColumn('nickname', 'text').execute();
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "users";`.execute(db);
}
