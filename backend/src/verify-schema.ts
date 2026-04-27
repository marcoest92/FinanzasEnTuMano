/**
 * Script temporal: verifica columnas default en `users` y CHECK de `category` en `transactions`.
 *
 * Desde la raíz del repo (usa el `.env` de `backend/`):
 *   npm run verify-schema
 *
 * Desde `backend/`:
 *   npx tsx src/verify-schema.ts
 *
 * Con ts-node (ESM, NodeNext):
 *   npx ts-node --esm src/verify-schema.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { randomBytes } from 'node:crypto';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
loadEnv({ path: path.join(backendRoot, '.env') });
import { getSupabase } from './supabase.js';

const TEST_TELEGRAM_ID = 999999999;

function firstDayOfCurrentMonthUtc(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function todayUtcYyyyMmDd(): string {
  return new Date().toISOString().slice(0, 10);
}

function printResult(ok: boolean, label: string, detail?: string): void {
  const icon = ok ? '✅' : '❌';
  const extra = detail ? ` — ${detail}` : '';
  console.log(`${icon} ${label}${extra}`);
}

function isCheckConstraintError(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  if (err.code === '23514') return true;
  const m = err.message ?? '';
  return /check constraint|violates check|new row for relation/i.test(m);
}

async function main(): Promise<void> {
  const sb = getSupabase();
  let userId: string | null = null;

  const cleanup = async () => {
    const { error } = await sb.from('users').delete().eq('telegram_id', TEST_TELEGRAM_ID);
    if (error) {
      console.log(`❌ Limpieza — ${error.message}`);
    } else {
      console.log('✅ Limpieza — filas con telegram_id = 999999999 eliminadas (CASCADE en transacciones).');
    }
  };

  try {
    await sb.from('users').delete().eq('telegram_id', TEST_TELEGRAM_ID);

    const dashboard_token = randomBytes(24).toString('hex');
    const { data: row, error: insUserErr } = await sb
      .from('users')
      .insert({
        telegram_id: TEST_TELEGRAM_ID,
        currency: 'COP',
        dashboard_token,
      })
      .select('id, plan, plan_expires_at, monthly_tx_count, monthly_tx_reset_at')
      .single();

    if (insUserErr || !row) {
      printResult(false, 'Insertar usuario de prueba', insUserErr?.message ?? 'sin fila');
      return;
    }
    printResult(true, 'Insertar usuario de prueba');
    userId = row.id as string;

    const planOk = row.plan === 'free';
    printResult(planOk, "Default plan === 'free'", planOk ? undefined : `obtenido: ${String(row.plan)}`);

    const expOk = row.plan_expires_at === null;
    printResult(expOk, 'Default plan_expires_at === null', expOk ? undefined : `obtenido: ${String(row.plan_expires_at)}`);

    const countOk = Number(row.monthly_tx_count) === 0;
    printResult(
      countOk,
      'Default monthly_tx_count === 0',
      countOk ? undefined : `obtenido: ${String(row.monthly_tx_count)}`
    );

    const expectedReset = firstDayOfCurrentMonthUtc();
    const resetVal = String(row.monthly_tx_reset_at).slice(0, 10);
    const resetOk = resetVal === expectedReset;
    printResult(
      resetOk,
      `Default monthly_tx_reset_at === primer día del mes (UTC: ${expectedReset})`,
      resetOk ? undefined : `obtenido: ${resetVal} (si difiere, Postgres puede usar otra TZ que UTC)`
    );

    const { error: badTxErr } = await sb.from('transactions').insert({
      user_id: userId,
      type: 'expense',
      amount: 100,
      category: 'Comida',
      description: 'verify-schema invalid category',
      date: todayUtcYyyyMmDd(),
    });
    const badOk = badTxErr != null && isCheckConstraintError(badTxErr);
    printResult(
      badOk,
      'Insert con categoría inválida (Comida) rechazado por constraint',
      badOk ? badTxErr!.message : badTxErr ? `error inesperado: ${badTxErr.message}` : 'no hubo error'
    );

    const { data: goodRow, error: goodTxErr } = await sb
      .from('transactions')
      .insert({
        user_id: userId,
        type: 'expense',
        amount: 2500,
        category: 'Alimentación',
        description: 'verify-schema valid category',
        date: todayUtcYyyyMmDd(),
      })
      .select('id, category')
      .single();

    const goodOk = !goodTxErr && goodRow?.category === 'Alimentación';
    printResult(
      goodOk,
      "Insert con categoría válida ('Alimentación')",
      goodOk ? undefined : goodTxErr?.message ?? JSON.stringify(goodRow)
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    printResult(false, 'Excepción no controlada', msg);
  } finally {
    await cleanup();
  }
}

void main();
