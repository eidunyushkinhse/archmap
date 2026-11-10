import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  const names = [{ oldName: 'notifications', newName: 'notification' }];
  for (const { oldName, newName } of names) {
    await sql.raw(`ALTER TABLE "${oldName}" RENAME TO "${newName}"`).execute(db);
  }
}

export async function down(): Promise<void> {}
