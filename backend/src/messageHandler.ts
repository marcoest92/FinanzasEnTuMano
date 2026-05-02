import type { Context } from 'telegraf';
import { Markup } from 'telegraf';
import {
  ASSISTANT_INTRO_MESSAGE,
  SAVED_MESSAGE,
  VOICE_ERROR,
  VOICE_PROCESSING,
} from './constants.js';
import { config } from './config.js';
import {
  checkAndIncrementTxCount,
  countReminders,
  createReminder,
  deleteReminder,
  deletePending,
  ensureUser,
  findUserByTelegram,
  getMonthSummary,
  getReminders,
  getPendingValid,
  insertTransaction,
  updateUserProfile,
  upsertPending,
  type UserRow,
} from './db.js';
import { formatCop, formatDateDdMmYyyy, parseLocalDate, dateYyyyMmDdBogota } from './format.js';
import { isLocalReminderIntent, tryLocalParse } from './localParser.js';
import {
  isReminderParseResult,
  parseTransactionText,
  type ParsedTransaction,
} from './openai/parseTransaction.js';
import {
  classifyPendingFollowup,
  pendingSummaryFromPayload,
} from './openai/pendingIntent.js';
import { transcribeOggOrMp3 } from './openai/transcribe.js';
import { isConfirmYes, isNoOrCancel } from './confirm.js';
import { isRateLimited } from './rateLimiter.js';
import {
  buildConfirmReminderCallbackData,
  buildFrequencyCallbackData,
  compactJsonToReminderIntent,
} from './reminderFlow.js';
import type { PendingPayload, Reminder, ReminderIntent } from './types.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Saludo corto sin datos de dinero: evita doble respuesta (bienvenida + resumen/OpenAI). */
function isLikelyPureGreeting(text: string): boolean {
  const t = text.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!t || t.startsWith('/')) return false;
  if (/\d/.test(t)) return false;
  if (t.length > 56) return false;
  return /^(¡?\s*hola\b|hi\b|hello\b|hey\b|buen[oa]s?\s+(días|tardes|noches)\b|buen día\b|qué tal\b|que tal\b|saludos)[\s!.¡¿?…]*$/iu.test(
    t
  );
}

function displayFirstName(ctx: Context): string {
  const raw = ctx.from?.first_name?.trim();
  return escapeHtml(raw && raw.length > 0 ? raw : 'ahí');
}

function userDashboardPublicUrl(user: UserRow): string {
  const base = config.dashboardPublicUrl();
  return `${base}/#/dashboard/${user.dashboard_token}`;
}

async function replyNewUserWelcome(ctx: Context): Promise<void> {
  const fn = displayFirstName(ctx);
  const text = `👋 ¡Hola ${fn}! Soy tu asistente de finanzas.
Escríbeme cualquier gasto o ingreso en lenguaje natural:
  • 'Almuerzo 15000'
  • 'Me pagaron 2 millones'
  • O envíame una nota de voz 🎙️

También tienes un dashboard web para ver resúmenes y movimientos: escribe /dashboard y te envío el enlace.

Empieza cuando quieras.`;
  await ctx.reply(text, { parse_mode: 'HTML' });
}

async function monthSummaryStatsHtml(
  userId: string,
  msgDateUnix: number
): Promise<{ inc: string; exp: string; balLine: string }> {
  const todayStr = dateYyyyMmDdBogota(msgDateUnix);
  const [y, m] = todayStr.split('-').map(Number);
  const { totalIncome, totalExpense } = await getMonthSummary(userId, y, m, msgDateUnix);
  const balance = totalIncome - totalExpense;
  const inc = escapeHtml(formatCop(totalIncome));
  const exp = escapeHtml(formatCop(totalExpense));
  const balLine =
    balance >= 0
      ? `💰 Balance: +${escapeHtml(formatCop(balance))}`
      : `💰 Balance: -${escapeHtml(formatCop(Math.abs(balance)))}`;
  return { inc, exp, balLine };
}

function remindersListHtml(reminders: Reminder[]): string {
  if (reminders.length === 0) {
    return (
      '🔔 <b>Tus recordatorios</b>\n\n' +
      'No tienes recordatorios guardados.\n\n' +
      'Crea uno escribiendo por ejemplo: <code>Arriendo el 5</code> o <code>Recordatorio Netflix el 12</code>.'
    );
  }
  const blocks = reminders.map((r, i) => {
    const nm = escapeHtml(r.name);
    const freq = r.recurring ? '🔁 Mensual' : '1️⃣ Una vez';
    const cat =
      r.category != null && r.category.length > 0 ? escapeHtml(r.category) : 'Sin categoría';
    const amt =
      r.amount != null && Number.isFinite(Number(r.amount))
        ? ` · ${escapeHtml(formatCop(Number(r.amount)))}`
        : '';
    return `${i + 1}. <b>${nm}</b>${amt}\n   📅 Día ${r.day_of_month} · ${freq}\n   🏷️ ${cat}`;
  });
  return `🔔 <b>Tus recordatorios</b>\n\n${blocks.join('\n\n')}`;
}

function remindersActionsKeyboard(reminders: Reminder[]) {
  const rows = reminders.map((r) => [
    Markup.button.callback('✏️ Editar', `edit_reminder_existing:${r.id}`),
    Markup.button.callback('🗑️ Eliminar', `delete_reminder:${r.id}`),
  ]);
  rows.push([Markup.button.callback('➕ Nuevo recordatorio', 'reminder_new')]);
  return Markup.inlineKeyboard(rows);
}

async function replyReturningUserHome(ctx: Context, user: UserRow, msgDateUnix: number): Promise<void> {
  const { inc, exp, balLine } = await monthSummaryStatsHtml(user.id, msgDateUnix);
  const fn = displayFirstName(ctx);
  const html = `👋 ¡Hola ${fn}!

Este mes llevas:
📥 Ingresos: ${inc}
📤 Gastos: ${exp}
${balLine}

¿Qué registramos hoy?`;
  await ctx.reply(html, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('📊 Dashboard', 'welcome_dashboard'),
        Markup.button.callback('📈 Resumen', 'welcome_resumen'),
        Markup.button.callback('🔔 Recordatorios', 'welcome_recordatorios'),
      ],
    ]),
  });
}

export async function handleWelcomeDashboard(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const user = await findUserByTelegram(from.id);
  if (!user) {
    await ctx.reply('No encontré tu cuenta. Escribe /start.');
    return;
  }
  await ctx.reply(`Tu dashboard: ${userDashboardPublicUrl(user)}`);
}

export async function handleWelcomeResumen(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const user = await findUserByTelegram(from.id);
  if (!user) {
    await ctx.reply('No encontré tu cuenta. Escribe /start.');
    return;
  }
  const msgDate =
    ctx.callbackQuery?.message && 'date' in ctx.callbackQuery.message
      ? ctx.callbackQuery.message.date
      : Math.floor(Date.now() / 1000);
  const { inc, exp, balLine } = await monthSummaryStatsHtml(user.id, msgDate);
  const text = `📈 <b>Resumen de este mes</b>\n\n📥 Ingresos: ${inc}\n📤 Gastos: ${exp}\n${balLine}`;
  await ctx.reply(text, { parse_mode: 'HTML' });
}

export async function handleWelcomeRecordatorios(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const user = await findUserByTelegram(from.id);
  if (!user) {
    await ctx.reply('No encontré tu cuenta. Escribe /start.');
    return;
  }
  const reminders = await getReminders(user.id);
  const text = remindersListHtml(reminders);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...remindersActionsKeyboard(reminders),
  });
}

export async function handleReminderNew(ctx: Context): Promise<void> {
  const msg = '✏️ Describe el nuevo recordatorio.\nEj: Arriendo el 5 o Servicios el 15';
  try {
    await ctx.editMessageText(msg, { reply_markup: { inline_keyboard: [] } });
  } catch {
    await ctx.reply(msg);
  }
}

export async function handleEditReminderExisting(ctx: Context, reminderId: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const user = await findUserByTelegram(from.id);
  if (!user) {
    await ctx.reply('No encontré tu cuenta. Escribe /start.');
    return;
  }
  const id = reminderId.trim();
  if (!id) {
    await ctx.reply('No tienes permiso para editar este recordatorio.');
    return;
  }
  const before = await getReminders(user.id);
  const owns = before.some((r) => r.id === id);
  if (!owns) {
    await ctx.reply('No tienes permiso para editar este recordatorio.');
    return;
  }
  await deleteReminder(id, user.id);
  const editPrompt =
    '✏️ Describe el recordatorio de nuevo.\nEj: Arriendo el 5 o Servicios el 15';
  try {
    await ctx.editMessageText(editPrompt, { reply_markup: { inline_keyboard: [] } });
  } catch {
    await ctx.reply(editPrompt);
  }
}

export async function handleDeleteReminder(ctx: Context, reminderId: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const user = await findUserByTelegram(from.id);
  if (!user) {
    await ctx.reply('No encontré tu cuenta. Escribe /start.');
    return;
  }
  const id = reminderId.trim();
  if (!id) {
    await ctx.reply('No tienes permiso para eliminar este recordatorio.');
    return;
  }
  const before = await getReminders(user.id);
  const owns = before.some((r) => r.id === id);
  if (!owns) {
    await ctx.reply('No tienes permiso para eliminar este recordatorio.');
    return;
  }
  await deleteReminder(id, user.id);
  const reminders = await getReminders(user.id);
  const text = remindersListHtml(reminders);
  const kb = remindersActionsKeyboard(reminders);
  try {
    await ctx.editMessageText(text, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'HTML', ...kb });
  }
}

function pendingShortSummary(p: PendingPayload): string {
  const t = p.type === 'income' ? 'Ingreso' : 'Gasto';
  const amt = p.amount != null ? formatCop(p.amount) : '(monto pendiente)';
  return `${t} ${amt} en ${p.category}.`;
}

function buildBlockPendingMessage(p: PendingPayload): string {
  return `Aún tengo pendiente confirmar el registro anterior:\n${pendingShortSummary(p)}\n¿Confirmas? (sí / no)`;
}

function buildConfirmationMessage(p: PendingPayload): string {
  const amount = p.amount!;
  const tipo =
    p.type === 'income'
      ? `un ingreso`
      : `un gasto`;
  const amountStr = formatCop(amount);
  const dateStr = formatDateDdMmYyyy(parseLocalDate(p.date));
  return `He registrado ${tipo} de ${amountStr} en ${p.category} el ${dateStr}.\n¿Confirmas?`;
}

function confirmationInlineKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('✅ Guardar', 'confirm_yes')],
    [Markup.button.callback('✏️ Corregir', 'confirm_edit')],
    [Markup.button.callback('❌ Cancelar', 'confirm_no')],
  ]);
}

function typeClarificationInlineKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📥 Gasto', 'clarify_expense')],
    [Markup.button.callback('📤 Ingreso', 'clarify_income')],
  ]);
}

/** Solo falta tipo: hay monto; botones Gasto/Ingreso en lugar de pregunta abierta. */
function isClarifyTypeOnly(parsed: ParsedTransaction): boolean {
  return parsed.needs_clarification && parsed.type === null && parsed.amount !== null;
}

function isUserProActive(user: UserRow): boolean {
  if (user.plan !== 'pro') return false;
  const expMs = user.plan_expires_at ? new Date(user.plan_expires_at).getTime() : NaN;
  return Number.isFinite(expMs) && expMs > Date.now();
}

async function replyReminderConfirmation(
  ctx: Context,
  user: UserRow,
  intent: ReminderIntent,
  defaultDate: string
): Promise<void> {
  await upsertPending(user.id, {
    category: '',
    description: '',
    date: defaultDate,
    reminder_draft: intent,
    reminder_phase: 'confirm',
  });
  const catLine =
    intent.category != null && intent.category.length > 0
      ? `🏷️ ${escapeHtml(intent.category)}`
      : '🏷️ Sin categoría';
  const text = `🔔 <b>Nuevo recordatorio</b>\n📋 ${escapeHtml(intent.name)}\n📅 Día ${intent.day_of_month} de cada mes\n${catLine}\n\n¿Guardamos este recordatorio?`;
  const confirmCb = buildConfirmReminderCallbackData(intent);
  await ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('✅ Guardar', confirmCb)],
      [Markup.button.callback('✏️ Corregir', 'edit_reminder')],
      [Markup.button.callback('❌ Cancelar', 'cancel_reminder')],
    ]),
  });
}

async function replyWithConfirmation(ctx: Context, p: PendingPayload): Promise<void> {
  await ctx.reply(buildConfirmationMessage(p), confirmationInlineKeyboard());
}

async function replyTypeClarificationPrompt(ctx: Context): Promise<void> {
  await ctx.reply('¿Es un gasto o un ingreso?', typeClarificationInlineKeyboard());
}

async function commitPendingTransaction(ctx: Context, user: UserRow, pending: PendingPayload): Promise<void> {
  if (pending.type === undefined || pending.amount === undefined) {
    await ctx.reply('Faltan datos del movimiento. Escribe el gasto o ingreso de nuevo.');
    await deletePending(user.id);
    return;
  }
  try {
    const countResult = await checkAndIncrementTxCount(user.id);
    if (countResult === 'limit_reached') {
      await ctx.reply(
        '⚠️ Alcanzaste tu límite de 40 registros este mes.\n\nEl plan Pro te da registros ilimitados por solo $9.900 COP/mes 👇',
        Markup.inlineKeyboard([[Markup.button.callback('🚀 Quiero el plan Pro', 'show_pro_info')]])
      );
      await deletePending(user.id);
      return;
    }
    await insertTransaction(
      user.id,
      pending.type,
      pending.amount,
      pending.category,
      pending.description,
      pending.date
    );
    await deletePending(user.id);
    await ctx.reply(SAVED_MESSAGE);
  } catch {
    await ctx.reply('No pude guardar el movimiento. Intenta de nuevo en unos segundos.');
  }
}

async function discardPendingTransaction(ctx: Context, userId: string): Promise<void> {
  await deletePending(userId);
  await ctx.reply('Listo, descarté el registro pendiente. Puedes enviar un nuevo movimiento.');
}

async function enterPendingEditMode(ctx: Context, userId: string, pending: PendingPayload): Promise<void> {
  await upsertPending(userId, { ...pending, awaiting_clarification: true });
  await ctx.reply('¿Qué quieres corregir? Escríbelo y lo actualizo.');
}

function isConfirmationPending(p: PendingPayload): boolean {
  return !p.awaiting_clarification && p.type !== undefined && p.amount !== undefined;
}

export async function handleConfirmReminderCallback(
  ctx: Context,
  jsonSuffix: string | null
): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const { user } = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
  let intent: ReminderIntent | null = null;
  if (jsonSuffix != null && jsonSuffix.trim().length > 0) {
    intent = compactJsonToReminderIntent(jsonSuffix.trim());
  }
  if (!intent) {
    const row = await getPendingValid(user.id);
    intent = row?.payload?.reminder_draft ?? null;
  }
  if (!intent) {
    await ctx.reply('Ese recordatorio ya no está disponible. Escríbelo de nuevo.');
    return;
  }
  const nowUnix = Math.floor(Date.now() / 1000);
  const defaultDate = dateYyyyMmDdBogota(nowUnix);
  await upsertPending(user.id, {
    category: '',
    description: '',
    date: defaultDate,
    reminder_draft: intent,
    reminder_phase: 'frequency',
  });
  const recCb = buildFrequencyCallbackData('recurring', intent);
  const onceCb = buildFrequencyCallbackData('once', intent);
  const body = '¿Este recordatorio es <b>mensual</b> o <b>solo para este mes</b>?';
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('🔁 Mensual', recCb), Markup.button.callback('1️⃣ Solo este mes', onceCb)],
  ]);
  try {
    await ctx.editMessageText(body, { parse_mode: 'HTML', ...kb });
  } catch {
    await ctx.reply(body, { parse_mode: 'HTML', ...kb });
  }
}

export async function handleEditReminder(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const { user } = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
  await deletePending(user.id);
  const msg = 'Describe el recordatorio de nuevo.';
  try {
    await ctx.editMessageText(msg, { reply_markup: { inline_keyboard: [] } });
  } catch {
    await ctx.reply(msg);
  }
}

export async function handleCancelReminder(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const { user } = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
  await deletePending(user.id);
  const msg = '❌ Cancelado.';
  try {
    await ctx.editMessageText(msg, { reply_markup: { inline_keyboard: [] } });
  } catch {
    await ctx.reply(msg);
  }
}

export async function handleReminderFrequencyCallback(
  ctx: Context,
  freq: 'recurring' | 'once',
  jsonSuffix: string | null
): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const { user } = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
  let intent: ReminderIntent | null = null;
  if (jsonSuffix != null && jsonSuffix.trim().length > 0) {
    intent = compactJsonToReminderIntent(jsonSuffix.trim());
  }
  if (!intent) {
    const row = await getPendingValid(user.id);
    intent = row?.payload?.reminder_draft ?? null;
  }
  if (!intent) {
    await ctx.reply('No encontré el recordatorio. Empieza de nuevo.');
    return;
  }

  if (!isUserProActive(user)) {
    const n = await countReminders(user.id);
    if (n >= 3) {
      await deletePending(user.id);
      const limitMsg =
        '⚠️ En el plan gratuito puedes tener hasta 3 recordatorios activos.\n\n' +
        'El plan Pro te permite recordatorios ilimitados por solo $9.900 COP/mes 👇';
      try {
        await ctx.editMessageText(limitMsg, {
          ...Markup.inlineKeyboard([[Markup.button.callback('🚀 Quiero el plan Pro', 'show_pro_info')]]),
        });
      } catch {
        await ctx.reply(
          limitMsg,
          Markup.inlineKeyboard([[Markup.button.callback('🚀 Quiero el plan Pro', 'show_pro_info')]])
        );
      }
      return;
    }
  }

  const recurring = freq === 'recurring';
  try {
    await createReminder({
      user_id: user.id,
      name: intent.name,
      day_of_month: intent.day_of_month,
      amount: null,
      category: intent.category,
      recurring,
    });
  } catch {
    await ctx.reply('No pude guardar el recordatorio. Intenta de nuevo en unos segundos.');
    return;
  }
  await deletePending(user.id);
  const freqLabel = recurring ? '🔁 Mensual' : '1️⃣ Solo este mes';
  const okText = `✅ <b>Recordatorio guardado</b>\n📋 ${escapeHtml(intent.name)}\n📅 Día ${intent.day_of_month}\n${freqLabel}`;
  try {
    await ctx.editMessageText(okText, { parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } });
  } catch {
    await ctx.reply(okText, { parse_mode: 'HTML' });
  }
}

export async function handleConfirmYes(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const { user } = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
  const row = await getPendingValid(user.id);
  const pending = row?.payload;
  if (!pending || !isConfirmationPending(pending)) {
    await ctx.reply('No hay confirmación pendiente.');
    return;
  }
  await commitPendingTransaction(ctx, user, pending);
}

export async function handleConfirmNo(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const { user } = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
  const row = await getPendingValid(user.id);
  const pending = row?.payload;
  if (!pending || !isConfirmationPending(pending)) {
    await ctx.reply('No hay confirmación pendiente.');
    return;
  }
  await discardPendingTransaction(ctx, user.id);
}

export async function handleConfirmEdit(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const { user } = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
  const row = await getPendingValid(user.id);
  const pending = row?.payload;
  if (!pending || !isConfirmationPending(pending)) {
    await ctx.reply('No hay confirmación pendiente.');
    return;
  }
  await enterPendingEditMode(ctx, user.id, pending);
}

export async function handleClarifyExpense(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const { user } = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
  const row = await getPendingValid(user.id);
  const pending = row?.payload;
  if (!pending?.awaiting_clarification || pending.amount == null) {
    await ctx.reply('No hay aclaración pendiente o falta el monto.');
    return;
  }
  const full: PendingPayload = {
    ...pending,
    type: 'expense',
    awaiting_clarification: false,
  };
  await upsertPending(user.id, full);
  await replyWithConfirmation(ctx, full);
}

export async function handleClarifyIncome(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const { user } = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
  const row = await getPendingValid(user.id);
  const pending = row?.payload;
  if (!pending?.awaiting_clarification || pending.amount == null) {
    await ctx.reply('No hay aclaración pendiente o falta el monto.');
    return;
  }
  const full: PendingPayload = {
    ...pending,
    type: 'income',
    awaiting_clarification: false,
  };
  await upsertPending(user.id, full);
  await replyWithConfirmation(ctx, full);
}

function toFullPayload(parsed: {
  type: 'income' | 'expense' | null;
  amount: number | null;
  category: string;
  description: string;
  date: string;
}): PendingPayload | null {
  if (parsed.type === null || parsed.amount === null) return null;
  return {
    type: parsed.type,
    amount: parsed.amount,
    category: parsed.category,
    description: parsed.description,
    date: parsed.date,
  };
}

export async function handleIncomingText(
  ctx: Context,
  text: string,
  preloaded?: { user: UserRow; skipWelcome: boolean; isNew?: boolean }
): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  if (isRateLimited(from.id)) {
    return;
  }

  const earlyUser = await findUserByTelegram(from.id);
  if (earlyUser && earlyUser.plan === 'free' && earlyUser.monthly_tx_count >= 40) {
    await ctx.reply(
      '⚠️ Alcanzaste tu límite de 40 registros este mes.\n\n' +
        'El plan Pro te da registros ilimitados por solo $9.900 COP/mes 👇',
      Markup.inlineKeyboard([[Markup.button.callback('🚀 Quiero el plan Pro', 'show_pro_info')]])
    );
    return;
  }

  const raw = text.trim();
  const msgDate =
    ctx.message && 'date' in ctx.message ? ctx.message.date : Math.floor(Date.now() / 1000);

  let user: UserRow;
  let isNew = false;
  if (preloaded) {
    user = preloaded.user;
    isNew = preloaded.isNew ?? false;
    if (isNew && !preloaded.skipWelcome) {
      await replyNewUserWelcome(ctx);
      if (isLikelyPureGreeting(raw)) {
        return;
      }
    }
  } else {
    const ensured = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
    user = ensured.user;
    isNew = ensured.isNew;
    if (isNew) {
      await replyNewUserWelcome(ctx);
      if (isLikelyPureGreeting(raw)) {
        return;
      }
    }
  }

  await updateUserProfile(user.id, from.first_name ?? null, from.username ?? null);
  if (raw.startsWith('/')) {
    if (raw.startsWith('/start')) {
      if (!isNew) await replyReturningUserHome(ctx, user, msgDate);
      return;
    }
    if (raw.startsWith('/dashboard')) {
      await ctx.reply(`Tu dashboard: ${userDashboardPublicUrl(user)}`);
      return;
    }
  }

  const defaultDate = dateYyyyMmDdBogota(msgDate);

  const pendingRow = await getPendingValid(user.id);
  const pending = pendingRow?.payload ?? null;

  if (!isNew && !pending && isLikelyPureGreeting(raw)) {
    await replyReturningUserHome(ctx, user, msgDate);
    return;
  }

  // --- Con pendiente (confirmación o aclaración)
  if (pending) {
    if (pending.reminder_draft && !pending.awaiting_clarification) {
      const phase = pending.reminder_phase ?? 'confirm';
      if (phase === 'frequency') {
        await ctx.reply(
          'Elige la frecuencia con los botones del mensaje anterior (🔁 Mensual o 1️⃣ Solo este mes).'
        );
        return;
      }
      await ctx.reply(
        'Confirma el recordatorio con los botones del mensaje anterior (✅ Guardar / ✏️ Corregir / ❌ Cancelar).'
      );
      return;
    }

    if (pending.awaiting_clarification) {
      const parsed = await parseTransactionText(raw, defaultDate, pending);
      if (isReminderParseResult(parsed)) {
        await deletePending(user.id);
        await replyReminderConfirmation(ctx, user, parsed, defaultDate);
        return;
      }
      if (parsed.is_greeting) {
        await ctx.reply(
          `${ASSISTANT_INTRO_MESSAGE}\n\nSigo pendiente de los datos del movimiento que estábamos armando.`
        );
        return;
      }
      if (parsed.needs_clarification) {
        const partial: PendingPayload = {
          type: parsed.type ?? pending.type,
          amount: parsed.amount ?? pending.amount,
          category: parsed.category,
          description: parsed.description,
          date: parsed.date,
          awaiting_clarification: true,
        };
        await upsertPending(user.id, partial);
        if (isClarifyTypeOnly(parsed)) {
          await replyTypeClarificationPrompt(ctx);
        } else if (parsed.clarification_question) {
          await ctx.reply(parsed.clarification_question);
        }
        return;
      }
      const full = toFullPayload(parsed);
      if (!full) {
        await ctx.reply('No pude completar los datos. ¿Es gasto o ingreso y de cuánto en COP?');
        return;
      }
      full.awaiting_clarification = false;
      await upsertPending(user.id, full);
      await replyWithConfirmation(ctx, full);
      return;
    }

    if (isConfirmYes(raw)) {
      await commitPendingTransaction(ctx, user, pending);
      return;
    }

    if (isNoOrCancel(raw)) {
      await discardPendingTransaction(ctx, user.id);
      return;
    }

    const summary = pendingSummaryFromPayload(
      pending,
      pending.amount != null ? formatCop(pending.amount) : '',
      pending.type === 'income' ? 'Ingreso' : 'Gasto'
    );
    const intent = await classifyPendingFollowup(raw, summary);
    if (intent.kind === 'new_attempt') {
      await ctx.reply(buildBlockPendingMessage(pending));
      return;
    }
    if (intent.kind === 'correct') {
      const parsed = await parseTransactionText(intent.mergedText, defaultDate, null);
      if (isReminderParseResult(parsed)) {
        await deletePending(user.id);
        await replyReminderConfirmation(ctx, user, parsed, defaultDate);
        return;
      }
      if (parsed.is_greeting) {
        await ctx.reply(`${ASSISTANT_INTRO_MESSAGE}\n\n${buildBlockPendingMessage(pending)}`);
        return;
      }
      if (parsed.needs_clarification) {
        const partial: PendingPayload = {
          type: parsed.type ?? pending.type,
          amount: parsed.amount ?? pending.amount,
          category: parsed.category,
          description: parsed.description,
          date: parsed.date,
          awaiting_clarification: true,
        };
        await upsertPending(user.id, partial);
        if (isClarifyTypeOnly(parsed)) {
          await replyTypeClarificationPrompt(ctx);
        } else if (parsed.clarification_question) {
          await ctx.reply(parsed.clarification_question);
        }
        return;
      }
      const full = toFullPayload(parsed);
      if (!full) {
        await ctx.reply('No pude aplicar la corrección. Intenta de nuevo.');
        return;
      }
      full.awaiting_clarification = false;
      await upsertPending(user.id, full);
      await replyWithConfirmation(ctx, full);
      return;
    }

    await ctx.reply(`${ASSISTANT_INTRO_MESSAGE}\n\n${buildBlockPendingMessage(pending)}`);
    return;
  }

  // --- Sin pendiente: nuevo parseo
  const localResult = tryLocalParse(raw, defaultDate);
  if (isLocalReminderIntent(localResult)) {
    console.log('[parser] local reminder:', raw, '→', JSON.stringify(localResult));
    await replyReminderConfirmation(ctx, user, localResult, defaultDate);
    return;
  }
  if (localResult && !localResult.needs_clarification && !localResult.is_greeting) {
    const full = toFullPayload(localResult);
    if (full) {
      console.log('[parser] local:', raw, '→', JSON.stringify(localResult));
      full.awaiting_clarification = false;
      await upsertPending(user.id, full);
      await replyWithConfirmation(ctx, full);
      return;
    }
  }
  console.log('[parser] openai:', raw);
  const parsed = await parseTransactionText(raw, defaultDate, null);
  if (isReminderParseResult(parsed)) {
    console.log('[parser] openai reminder:', raw, '→', JSON.stringify(parsed));
    await replyReminderConfirmation(ctx, user, parsed, defaultDate);
    return;
  }
  if (parsed.is_greeting) {
    if (!isNew) {
      await replyReturningUserHome(ctx, user, msgDate);
    }
    return;
  }
  if (parsed.needs_clarification) {
    const partial: PendingPayload = {
      type: parsed.type ?? undefined,
      amount: parsed.amount ?? undefined,
      category: parsed.category,
      description: parsed.description,
      date: parsed.date,
      awaiting_clarification: true,
    };
    await upsertPending(user.id, partial);
    if (isClarifyTypeOnly(parsed)) {
      await replyTypeClarificationPrompt(ctx);
    } else if (parsed.clarification_question) {
      await ctx.reply(parsed.clarification_question);
    }
    return;
  }

  const full = toFullPayload(parsed);
  if (!full) {
    await ctx.reply('No identifiqué el monto o el tipo de movimiento. Ejemplo: "Almuerzo 15000" o "Me pagaron 50000".');
    return;
  }
  full.awaiting_clarification = false;
  await upsertPending(user.id, full);
  await replyWithConfirmation(ctx, full);
}

export async function handleVoice(ctx: Context): Promise<void> {
  const from = ctx.from;
  const msg = ctx.message;
  if (!from || !msg || !('voice' in msg) || !msg.voice) return;

  if (isRateLimited(from.id)) {
    return;
  }

  const ensured = await ensureUser(from.id, from.first_name ?? null, from.username ?? null);
  if (ensured.isNew) await replyNewUserWelcome(ctx);
  await ctx.reply(VOICE_PROCESSING);
  const fileId = msg.voice.file_id;
  let fileLink: string;
  try {
    const link = await ctx.telegram.getFileLink(fileId);
    fileLink = typeof link === 'string' ? link : link.href;
  } catch {
    await ctx.reply(VOICE_ERROR);
    return;
  }
  let buf: Buffer;
  try {
    const res = await fetch(fileLink);
    if (!res.ok) throw new Error('download failed');
    buf = Buffer.from(await res.arrayBuffer());
  } catch {
    await ctx.reply(VOICE_ERROR);
    return;
  }

  let text: string;
  try {
    text = await transcribeOggOrMp3(buf, 'voice.ogg');
  } catch {
    await ctx.reply(VOICE_ERROR);
    return;
  }
  if (!text.trim()) {
    await ctx.reply(VOICE_ERROR);
    return;
  }
  await handleIncomingText(ctx, text, {
    user: ensured.user,
    skipWelcome: true,
    isNew: ensured.isNew,
  });
}
