/**
 * Aplica la migración users.plan + get_dashboard_user contra la base remota.
 * Requiere SUPABASE_DB_URL en .env (Supabase Dashboard → Project Settings → Database → URI, modo Transaction).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(__dirname, '../../supabase/migrations/20260423120000_users_plan.sql');

async function main(): Promise<void> {
  const url = process.env.SUPABASE_DB_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'Falta SUPABASE_DB_URL o DATABASE_URL en .env.\n' +
        'Copia la URI de Postgres desde Supabase → Project Settings → Database (incluye la contraseña).'
    );
    process.exit(1);
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query(sql);
    console.log('Migración aplicada:', path.basename(sqlPath));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
