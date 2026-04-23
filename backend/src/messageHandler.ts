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
  deletePending,
  ensureUser,
  getPendingValid,
  insertTransaction,
  upsertPending,
  type UserRow,
} from './db.js';
import { formatCop, formatDateDdMmYyyy, parseLocalDate, dateYyyyMmDdBogota } from './format.js';
import { parseTransactionText, type ParsedTransaction } from './openai/parseTransaction.js';
import {
  classifyPendingFollowup,
  pendingSummaryFromPayload,
} from './openai/pendingIntent.js';
import { transcribeOggOrMp3 } from './openai/transcribe.js';
import { isConfirmYes, isNoOrCancel } from './confirm.js';
import type { PendingPayload } from './types.js';

const WELCOME_MESSAGE_TEXT = `¡Hola! Soy tu asistente de finanzas 💰
Escríbeme cualquier gasto o ingreso en lenguaje natural, por ejemplo:
  • 'Almuerzo 15000'
  • 'Me pagaron 2 millones'
  • También puedes enviar una nota de voz 🎙️`;

async function replyWelcome(ctx: Context): Promise<void> {
  await ctx.reply(
    WELCOME_MESSAGE_TEXT,
    Markup.inlineKeyboard([
      [Markup.button.callback('📊 Ver resumen del mes', 'show_summary')],
      [Markup.button.callback('❓ ¿Cómo funciono?', 'show_help')],
    ])
  );
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

export async function handleConfirmYes(ctx: Context): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  const { user } = await ensureUser(from.id);
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
  const { user } = await ensureUser(from.id);
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
  const { user } = await ensureUser(from.id);
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
  const { user } = await ensureUser(from.id);
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
  const { user } = await ensureUser(from.id);
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
  preloaded?: { user: UserRow; skipWelcome: boolean }
): Promise<void> {
  const from = ctx.from;
  if (!from) return;

  let user: UserRow;
  let isNew = false;
  if (preloaded) {
    user = preloaded.user;
    if (!preloaded.skipWelcome) await replyWelcome(ctx);
  } else {
    const ensured = await ensureUser(from.id);
    user = ensured.user;
    isNew = ensured.isNew;
    if (isNew) await replyWelcome(ctx);
  }

  const raw = text.trim();
  if (raw.startsWith('/')) {
    if (raw.startsWith('/start')) {
      if (!isNew) await replyWelcome(ctx);
      return;
    }
    if (raw.startsWith('/dashboard')) {
      const base = config.dashboardPublicUrl();
      await ctx.reply(`Tu dashboard: ${base}/#/dashboard/${user.dashboard_token}`);
      return;
    }
  }

  const msgDate = ctx.message && 'date' in ctx.message ? ctx.message.date : Math.floor(Date.now() / 1000);
  const defaultDate = dateYyyyMmDdBogota(msgDate);

  const pendingRow = await getPendingValid(user.id);
  const pending = pendingRow?.payload ?? null;

  // --- Con pendiente (confirmación o aclaración)
  if (pending) {
    if (pending.awaiting_clarification) {
      const parsed = await parseTransactionText(raw, defaultDate, pending);
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
  const parsed = await parseTransactionText(raw, defaultDate, null);
  if (parsed.is_greeting) {
    await ctx.reply(ASSISTANT_INTRO_MESSAGE);
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

  const ensured = await ensureUser(from.id);
  if (ensured.isNew) await replyWelcome(ctx);
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
  await handleIncomingText(ctx, text, { user: ensured.user, skipWelcome: true });
}
