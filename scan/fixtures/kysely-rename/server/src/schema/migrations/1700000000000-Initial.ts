import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "users" ("id" uuid NOT NULL PRIMARY KEY, "email" character varying NOT NULL)`.execute(db);
  await sql`CREATE TABLE "albums" ("id" uuid NOT NULL PRIMARY KEY, "ownerId" uuid NOT NULL REFERENCES "users" ("id"))`.execute(db);
  await sql`CREATE TABLE "albums_assets_assets" ("albumsId" uuid NOT NULL REFERENCES "albums" ("id"), "assetsId" uuid NOT NULL)`.execute(db);
  await sql`CREATE TABLE "activity" ("id" uuid NOT NULL PRIMARY KEY, "albumId" uuid REFERENCES "albums_assets_assets" ("albumsId"))`.execute(db);
  await sql`CREATE TABLE "sessions" ("id" uuid NOT NULL PRIMARY KEY, "userId" uuid REFERENCES "users" ("id"))`.execute(db);
  await sql`CREATE TABLE "tags" ("id" uuid NOT NULL PRIMARY KEY)`.execute(db);
  await sql`CREATE TABLE "partners" ("id" uuid NOT NULL PRIMARY KEY)`.execute(db);
  await sql`CREATE TABLE "notifications" ("id" uuid NOT NULL PRIMARY KEY)`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "users";`.execute(db);
}
