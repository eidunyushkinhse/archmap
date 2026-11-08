import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "albums" ("id" uuid NOT NULL, "ownerId" uuid NOT NULL REFERENCES "users" ("id"), "name" character varying NOT NULL)`.execute(db);
  await sql`CREATE TABLE ${sql.table(tableName)} ("id" uuid)`.execute(db);
}

export const down = async (db: Kysely<any>) => {
  await sql`DROP TABLE "albums"`.execute(db);
};
