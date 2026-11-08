import { Kysely, sql } from 'kysely';

const tables = [{ oldName: 'users', newName: 'user' }];

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "albums" ADD COLUMN "description" text NOT NULL DEFAULT ''`.execute(db);
  for (const { oldName, newName } of tables) {
    await sql.raw(`ALTER TABLE "${oldName}" RENAME TO "${newName}"`).execute(db);
  }
}
