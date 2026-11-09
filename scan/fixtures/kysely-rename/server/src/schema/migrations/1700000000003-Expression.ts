import { Kysely, sql } from 'kysely';

const renames = [{ oldName: 'tags', newName: 'Tag' }];

export async function up(db: Kysely<any>): Promise<void> {
  for (const { oldName, newName } of renames) {
    await sql.raw(`ALTER TABLE "${oldName}" RENAME TO "${newName.toLowerCase()}"`).execute(db);
  }
}

export async function down(): Promise<void> {}
