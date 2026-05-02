import { randomBytes } from 'node:crypto';
import { getSupabase } from './supabase.js';
import { dateYyyyMmDdBogota, firstDayOfCurrentMonthBogota } from './format.js';
import type { PendingPayload, Reminder, ReminderLog, UserPlan } from './types.js';
import { DEFAULT_USER_PLAN } from './types.js';
import type { TxType } from './types.js';

/** Columnas devueltas por PostgREST al leer/crear usuario (alineado con schema Supabase). */
const USER_ROW_SELECT =
  'id, telegram_id, currency, dashboard_token, created_at, plan, plan_expires_at, monthly_tx_count, monthly_tx_reset_at, first_name, username' as const;

const REMINDER_ROW_SELECT =
  'id, user_id, name, day_of_month, amount, category, recurring, created_at' as const;

const REMINDER_LOG_ROW_SELECT =
  'id, reminder_id, user_id, year_month, paid, paid_at, transaction_id, created_at' as const;

function mapReminderRow(r: Record<string, unknown>): Reminder {
  return {
    id: String(r.id),
    user_id: String(r.user_id),
    name: String(r.name),
    day_of_month: Number(r.day_of_month),
    amount: r.amount === null || r.amount === undefined ? null : Number(r.amount),
    category: r.category === null || r.category === undefined ? null : String(r.category),
    recurring: Boolean(r.recurring),
    created_at: String(r.created_at),
  };
}

function mapReminderLogRow(r: Record<string, unknown>): ReminderLog {
  return {
    id: String(r.id),
    reminder_id: String(r.reminder_id),
    user_id: String(r.user_id),
    year_month: String(r.year_month),
    paid: Boolean(r.paid),
    paid_at: r.paid_at === null || r.paid_at === undefined ? null : String(r.paid_at),
    transaction_id:
      r.transaction_id === null || r.transaction_id === undefined ? null : String(r.transaction_id),
    created_at: String(r.created_at),
  };
}

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

export async function getWeeklySummary(
  userId: string,
  weekStart: string,
  weekEnd: string
): Promise<{ totalIncome: number; totalExpense: number }> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('transactions')
    .select('type, amount')
    .eq('user_id', userId)
    .gte('date', weekStart)
    .lte('date', weekEnd);
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

export async function getCategorySummary(
  userId: string,
  dateFrom: string,
  dateTo: string
): Promise<{ category: string; total: number }[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('transactions')
    .select('category, amount')
    .eq('user_id', userId)
    .eq('type', 'expense')
    .gte('date', dateFrom)
    .lte('date', dateTo);
  if (error) throw error;

  const map = new Map<string, number>();
  for (const row of data ?? []) {
    const c = String(row.category);
    const a = Number(row.amount);
    if (!Number.isFinite(a)) continue;
    map.set(c, (map.get(c) ?? 0) + a);
  }
  return [...map.entries()]
    .map(([category, total]) => ({ category, total }))
    .sort((a, b) => b.total - a.total);
}

export async function getAllActiveUsers(): Promise<{ id: string; telegram_id: number; plan: string }[]> {
  const sb = getSupabase();
  const { data, error } = await sb.from('users').select('id, telegram_id, plan');
  if (error) throw error;
  return (data ?? []).map((r) => {
    const row = r as Record<string, unknown>;
    return {
      id: String(row.id),
      telegram_id: Number(row.telegram_id),
      plan: String(row.plan),
    };
  });
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
  first_name: string | null;
  username: string | null;
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

export async function createUser(
  telegramId: number,
  firstName: string | null,
  username: string | null
): Promise<UserRow> {
  const dashboard_token = randomBytes(24).toString('hex');
  const sb = getSupabase();
  const { data, error } = await sb
    .from('users')
    .insert({
      telegram_id: telegramId,
      currency: 'COP',
      dashboard_token,
      plan: DEFAULT_USER_PLAN,
      first_name: firstName,
      username,
    })
    .select(USER_ROW_SELECT)
    .single();
  if (error) throw error;
  return data as UserRow;
}

export async function ensureUser(
  telegramId: number,
  firstName: string | null,
  username: string | null
): Promise<{ user: UserRow; isNew: boolean }> {
  const existing = await findUserByTelegram(telegramId);
  if (existing) return { user: existing, isNew: false };
  const user = await createUser(telegramId, firstName, username);
  return { user, isNew: true };
}

export async function updateUserProfile(
  userId: string,
  firstName: string | null,
  username: string | null
): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from('users').update({ first_name: firstName, username }).eq('id', userId);
  if (error) throw error;
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
    if (error || !data) throw error ?? new Error('Usuario no encontrado');
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
      if (demoteErr) throw demoteErr;
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
      if (upErr) throw upErr;
      if (updated) return 'ok';
      continue;
    }

    const count = row.monthly_tx_count;
    if (count >= FREE_MONTHLY_TX_LIMIT) {
      return 'limit_reached';
    }

    const { data: incRow, error: incErr } = await sb
      .from('users')
      .update({ monthly_tx_count: count + 1 })
      .eq('id', userId)
      .eq('monthly_tx_count', count)
      .select('id')
      .maybeSingle();
    if (incErr) throw incErr;
    if (incRow) return 'ok';
  }

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
): Promise<string> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('transactions')
    .insert({
      user_id: userId,
      type,
      amount,
      category,
      description,
      date: dateYyyyMmDd,
    })
    .select('id')
    .single();
  if (error) throw error;
  return String((data as { id: unknown }).id);
}

export async function getReminderByIdForUser(reminderId: string, userId: string): Promise<Reminder | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('reminders')
    .select(REMINDER_ROW_SELECT)
    .eq('id', reminderId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return mapReminderRow(data as Record<string, unknown>);
}

export async function getReminders(userId: string): Promise<Reminder[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('reminders')
    .select(REMINDER_ROW_SELECT)
    .eq('user_id', userId)
    .order('day_of_month', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => mapReminderRow(row as Record<string, unknown>));
}

export async function createReminder(data: Omit<Reminder, 'id' | 'created_at'>): Promise<Reminder> {
  const sb = getSupabase();
  const { data: row, error } = await sb
    .from('reminders')
    .insert({
      user_id: data.user_id,
      name: data.name,
      day_of_month: data.day_of_month,
      amount: data.amount,
      category: data.category,
      recurring: data.recurring,
    })
    .select(REMINDER_ROW_SELECT)
    .single();
  if (error) throw error;
  return mapReminderRow(row as Record<string, unknown>);
}

export async function deleteReminder(reminderId: string, userId: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from('reminders').delete().eq('id', reminderId).eq('user_id', userId);
  if (error) throw error;
}

export async function countReminders(userId: string): Promise<number> {
  const sb = getSupabase();
  const { count, error } = await sb
    .from('reminders')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw error;
  return count ?? 0;
}

type ReminderWithUsersJoin = Record<string, unknown> & {
  users?: { telegram_id?: number | string } | { telegram_id?: number | string }[] | null;
};

export async function getRemindersByDay(
  dayOfMonth: number
): Promise<(Reminder & { telegram_id: number })[]> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('reminders')
    .select(`${REMINDER_ROW_SELECT}, users!inner(telegram_id)`)
    .eq('day_of_month', dayOfMonth);
  if (error) throw error;

  const out: (Reminder & { telegram_id: number })[] = [];
  for (const raw of data ?? []) {
    const row = raw as ReminderWithUsersJoin;
    const u = row.users;
    const nested = Array.isArray(u) ? u[0] : u;
    const tg = nested?.telegram_id;
    if (tg === undefined || tg === null) continue;
    const n = Number(tg);
    if (!Number.isFinite(n)) continue;
    const { users: _u, ...rest } = row;
    out.push({
      ...mapReminderRow(rest as Record<string, unknown>),
      telegram_id: n,
    });
  }
  return out;
}

export async function getReminderLog(reminderId: string, yearMonth: string): Promise<ReminderLog | null> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('reminder_logs')
    .select(REMINDER_LOG_ROW_SELECT)
    .eq('reminder_id', reminderId)
    .eq('year_month', yearMonth)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return mapReminderLogRow(data as Record<string, unknown>);
}

export async function upsertReminderLog(
  data: Partial<ReminderLog> & { reminder_id: string; user_id: string; year_month: string }
): Promise<ReminderLog> {
  const sb = getSupabase();
  const row: Record<string, unknown> = {
    reminder_id: data.reminder_id,
    user_id: data.user_id,
    year_month: data.year_month,
  };
  if (data.paid !== undefined) row.paid = data.paid;
  if (data.paid_at !== undefined) row.paid_at = data.paid_at;
  if (data.transaction_id !== undefined) row.transaction_id = data.transaction_id;

  const { data: inserted, error } = await sb
    .from('reminder_logs')
    .upsert(row, { onConflict: 'reminder_id,year_month' })
    .select(REMINDER_LOG_ROW_SELECT)
    .single();
  if (error) throw error;
  return mapReminderLogRow(inserted as Record<string, unknown>);
}

export async function deleteNonRecurringReminder(reminderId: string): Promise<void> {
  const sb = getSupabase();
  const { error } = await sb.from('reminders').delete().eq('id', reminderId).eq('recurring', false);
  if (error) throw error;
}
