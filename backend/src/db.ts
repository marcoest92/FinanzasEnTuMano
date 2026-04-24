import { randomBytes } from 'node:crypto';
import { getSupabase } from './supabase.js';
import { dateYyyyMmDdBogota } from './format.js';
import type { PendingPayload, UserPlan } from './types.js';
import { DEFAULT_USER_PLAN } from './types.js';
import type { TxType } from './types.js';

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
  plan: UserPlan;
}

export async function findUserByTelegram(telegramId: number): Promise<UserRow | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('users')
    .select('id, telegram_id, currency, dashboard_token, created_at, plan')
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
    .select('id, telegram_id, currency, dashboard_token, created_at, plan')
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
