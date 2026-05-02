/**
 * Configurar en cron-job.org: GET /cron/daily todos los días a las 8:00am hora Bogotá,
 * header x-cron-secret: {CRON_SECRET}
 */
import type { Telegraf } from 'telegraf';
import { dateYyyyMmDdBogota } from './format.js';
import { getReminderLog, getRemindersByDay } from './db.js';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Último día del mes calendario en Bogotá (month 1–12). */
function daysInMonthBogota(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Días del mes a consultar: hoy + “cola” 29–31 si hoy es el último día del mes. */
function reminderDaysToQuery(todayYmd: string): number[] {
  const [year, month, todayDay] = todayYmd.split('-').map(Number);
  const dim = daysInMonthBogota(year, month);
  const set = new Set<number>([todayDay]);
  if (todayDay === dim) {
    for (let d = dim + 1; d <= 31; d++) {
      set.add(d);
    }
  }
  return [...set].sort((a, b) => a - b);
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function sendDailyReminders(bot: Telegraf): Promise<void> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const todayYmd = dateYyyyMmDdBogota(nowUnix);
  const [y, m] = todayYmd.split('-').map(Number);
  const yearMonth = `${y}-${pad2(m)}`;

  const days = reminderDaysToQuery(todayYmd);
  const byId = new Map<string, Awaited<ReturnType<typeof getRemindersByDay>>[number]>();

  for (const day of days) {
    const rows = await getRemindersByDay(day);
    for (const r of rows) {
      byId.set(r.id, r);
    }
  }

  for (const reminder of byId.values()) {
    try {
      const log = await getReminderLog(reminder.id, yearMonth);
      if (log?.paid === true) continue;

      const text =
        `🔔 <b>${escapeHtml(reminder.name)}</b>\n` +
        '📅 Vence hoy\n' +
        '¿Lo pagaste?';

      await bot.telegram.sendMessage(reminder.telegram_id, text, {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Pagado', callback_data: `reminder_paid:${reminder.id}` },
              { text: '⏭️ Omitir', callback_data: `reminder_skip:${reminder.id}` },
            ],
          ],
        },
      });
    } catch (e) {
      console.error('[sendDailyReminders] sendMessage failed', { reminderId: reminder.id, error: e });
    }
    await delayMs(100);
  }
}
