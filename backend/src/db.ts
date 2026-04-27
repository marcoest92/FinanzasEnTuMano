import { randomBytes } from 'node:crypto';
import { getSupabase } from './supabase.js';
import { dateYyyyMmDdBogota, firstDayOfCurrentMonthBogota } from './format.js';
import type { PendingPayload, UserPlan } from './types.js';
import { DEFAULT_USER_PLAN } from './types.js';
import type { TxType } from './types.js';

/** Columnas devueltas por PostgREST al leer/crear usuario (alineado con schema Supabase). */
const USER_ROW_SELECT =
  'id, telegram_id, currency, dashboard_token, created_at, plan, plan_expires_at, monthly_tx_count, monthly_tx_reset_at' as const;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Último día del mes calendario (month 1–12), YYYY-MM-DD. */
function lastDayOfMonthYyyyMmDd(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Suma de ingresos y gastos en `transactions` para el usuario, con `date` entre el día 1 del mes
 * (year, month) y el final del rango: si es el mes calendario actual en Bogotá (según `nowUnixSeconds`),
 * hasta ese día inclusive; si es un mes pasado, hasta el último día del mes.
 */
export async function getMonthSummary(
  userId: string,
  year: number,
  month: number,
  nowUnixSeconds: number = Math.floor(Date.now() / 1000)
): Promise<{ totalIncome: number; totalExpense: number }> {
  const first = `${year}-${pad2(month)}-01`;
  const lastCal = lastDayOfMonthYyyyMmDd(year, month);
  const todayStr = dateYyyyMmDdBogota(nowUnixSeconds);
  const [ty, tm] = todayStr.split('-').map(Number);
  const isCurrentMonth = year === ty && month === tm;
  const end = isCurrentMonth ? (todayStr < lastCal ? todayStr : lastCal) : lastCal;

  const sb = getSupabase();
  const { data, error } = await sb
    .from('transactions')
    .select('type, amount')
    .eq('user_id', userId)
    .gte('date', first)
    .lte('date', end);
  if (error) throw error;

  let totalIncome = 0;
  let totalExpense = 0;
  for (const row of data ?? []) {
    const amt = Number(row.amount);
    if (!Number.isFinite(amt)) continue;
    if (row.type === 'income') totalIncome += amt;
    else if (row.type === 'expense') totalExpense += amt;
  }
  return { totalIncome, totalExpense };
}

export interface UserRow {
  id: string;
  telegram_id: number;
  currency: string;
  dashboard_token: string;
  created_at: string;
  /** Tier en DB (text); valores conocidos en `UserPlan`. */
  plan: string;
  plan_expires_at: string | null;
  monthly_tx_count: number;
  /** YYYY-MM-DD (columna date en Postgres). */
  monthly_tx_reset_at: string;
}

export async function findUserByTelegram(telegramId: number): Promise<UserRow | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('users')
    .select(USER_ROW_SELECT)
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (error) throw error;
  return data as UserRow | null;
}

export async function createUser(telegramId: number): Promise<UserRow> {
  const dashboard_token = randomBytes(24).toString('hex');
  const sb = getSupabase();
  const { data, error } = await sb
    .from('users')
    .insert({ telegram_id: telegramId, currency: 'COP', dashboard_token, plan: DEFAULT_USER_PLAN })
    .select(USER_ROW_SELECT)
    .single();
  if (error) throw error;
  return data as UserRow;
}

export async function ensureUser(telegramId: number): Promise<{ user: UserRow; isNew: boolean }> {
  const existing = await findUserByTelegram(telegramId);
  if (existing) return { user: existing, isNew: false };
  const user = await createUser(telegramId);
  return { user, isNew: true };
}

export interface PendingRow {
  id: string;
  user_id: string;
  payload: PendingPayload;
  expires_at: string;
  created_at: string;
}

export async function getPendingValid(userId: string): Promise<PendingRow | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('pending_transactions')
    .select('id, user_id, payload, expires_at, created_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as PendingRow;
  const exp = new Date(row.expires_at).getTime();
  if (exp < Date.now()) {
    await sb.from('pending_transactions').delete().eq('user_id', userId);
    return null;
  }
  return row;
}

export async function upsertPending(userId: string, payload: PendingPayload): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from('pending_transactions').upsert(
    {
      user_id: userId,
      payload: payload as unknown as Record<string, unknown>,
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) throw error;
}

export async function deletePending(userId: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from('pending_transactions').delete().eq('user_id', userId);
  if (error) throw error;
}

const FREE_MONTHLY_TX_LIMIT = 40;
const QUOTA_RETRY_MAX = 10;

type UserQuotaRow = {
  plan: string;
  plan_expires_at: string | null;
  monthly_tx_count: number;
  monthly_tx_reset_at: string;
};

function parseYyyyMm(yyyyMmDd: string): { y: number; m: number } {
  const s = yyyyMmDd.slice(0, 10);
  const [y, m] = s.split('-').map(Number);
  return { y, m };
}

/** (a) estrictamente anterior a (b) en calendario año-mes. */
function isStrictlyPriorCalendarMonth(
  a: { y: number; m: number },
  b: { y: number; m: number }
): boolean {
  return a.y < b.y || (a.y === b.y && a.m < b.m);
}

/**
 * Comprueba cupo freemium e incrementa el contador mensual antes de insertar la transacción.
 * Lanza si falla un `.update()` en Supabase.
 */
export async function checkAndIncrementTxCount(userId: string): Promise<'ok' | 'limit_reached'> {
  const sb = getSupabase();

  const fetchQuota = async (): Promise<UserQuotaRow> => {
    const { data, error } = await sb
      .from('users')
      .select('plan, plan_expires_at, monthly_tx_count, monthly_tx_reset_at')
      .eq('id', userId)
      .single();
    if (error || !data) {
      console.log('[quota] error:', error, !data ? '(sin data)' : '');
      throw error ?? new Error('Usuario no encontrado');
    }
    const r = data as Record<string, unknown>;
    return {
      plan: String(r.plan),
      plan_expires_at: (r.plan_expires_at as string | null) ?? null,
      monthly_tx_count: Number(r.monthly_tx_count),
      monthly_tx_reset_at: String(r.monthly_tx_reset_at).slice(0, 10),
    };
  };

  for (let attempt = 0; attempt < QUOTA_RETRY_MAX; attempt++) {
    let row = await fetchQuota();
    console.log(`[quota] attempt ${attempt}, row:`, JSON.stringify(row));

    if (row.plan === 'pro') {
      const nowMs = Date.now();
      const expMs = row.plan_expires_at ? new Date(row.plan_expires_at).getTime() : NaN;
      const proVigente = Number.isFinite(expMs) && expMs > nowMs;
      if (proVigente) {
        return 'ok';
      }
      const { error: demoteErr } = await sb
        .from('users')
        .update({ plan: 'free', plan_expires_at: null })
        .eq('id', userId);
      if (demoteErr) {
        console.log('[quota] error:', demoteErr);
        throw demoteErr;
      }
      row = await fetchQuota();
    }

    const nowUnix = Math.floor(Date.now() / 1000);
    const bogotaToday = dateYyyyMmDdBogota(nowUnix);
    const currentYm = parseYyyyMm(bogotaToday);
    const resetYm = parseYyyyMm(row.monthly_tx_reset_at);
    const priorMonth = isStrictlyPriorCalendarMonth(resetYm, currentYm);

    if (priorMonth) {
      const firstDay = firstDayOfCurrentMonthBogota(nowUnix);
      const { data: updated, error: upErr } = await sb
        .from('users')
        .update({ monthly_tx_count: 1, monthly_tx_reset_at: firstDay })
        .eq('id', userId)
        .eq('monthly_tx_reset_at', row.monthly_tx_reset_at)
        .eq('monthly_tx_count', row.monthly_tx_count)
        .select('id')
        .maybeSingle();
      if (upErr) {
        console.log('[quota] error:', upErr);
        throw upErr;
      }
      if (updated) return 'ok';
      continue;
    }

    const count = row.monthly_tx_count;
    if (count >= FREE_MONTHLY_TX_LIMIT) {
      console.log('[quota] limit_reached, count:', count);
      return 'limit_reached';
    }

    const { data: incRow, error: incErr } = await sb
      .from('users')
      .update({ monthly_tx_count: count + 1 })
      .eq('id', userId)
      .eq('monthly_tx_count', count)
      .select('id')
      .maybeSingle();
    if (incErr) {
      console.log('[quota] error:', incErr);
      throw incErr;
    }
    if (incRow) return 'ok';
  }

  console.log('[quota] retries exhausted');
  throw new Error('No se pudo actualizar el contador de transacciones. Intenta de nuevo.');
}

/** Inserta la fila en `transactions`. El cupo mensual se aplica antes con `checkAndIncrementTxCount`. */
export async function insertTransaction(
  userId: string,
  type: TxType,
  amount: number,
  category: string,
  description: string,
  dateYyyyMmDd: string
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from('transactions').insert({
    user_id: userId,
    type,
    amount,
    category,
    description,
    date: dateYyyyMmDd,
  });
  if (error) throw error;
}
