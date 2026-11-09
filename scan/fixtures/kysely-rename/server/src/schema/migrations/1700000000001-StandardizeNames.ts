import { Kysely, sql } from 'kysely';

type RenameItem = { oldName: string; newName: string };

const tables: RenameItem[] = [
  { oldName: 'users', newName: 'user' },
  { oldName: 'albums', newName: 'album' },
  // Пары идут по порядку, комментарий внутри списка не мешает.
  { oldName: 'albums_assets_assets', newName: 'album_asset' },
];

const pairs = [['sessions', 'session']] as const;

const prefix = 'old_';
const computed = [{ oldName: prefix + 'partners', newName: 'partner' }];

export async function up(db: Kysely<any>): Promise<void> {
  for (const { oldName, newName } of tables) {
    await sql.raw(`ALTER TABLE "${oldName}" RENAME TO "${newName}"`).execute(db);
  }
  for (const [from, to] of pairs) await sql.raw(`ALTER TABLE "${from}" RENAME TO "${to}"`).execute(db);
  for (const { oldName, newName } of computed) {
    await sql.raw(`ALTER TABLE "${oldName}" RENAME TO "${newName}"`).execute(db);
  }
  await sql`ALTER TABLE "album_asset" RENAME COLUMN "albumsId" TO "albumId";`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  for (const { oldName, newName } of tables) {
    await sql.raw(`ALTER TABLE "${newName}" RENAME TO "${oldName}"`).execute(db);
  }
}
