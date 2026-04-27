import type { Telegraf } from 'telegraf';
import {
  getAllActiveUsers,
  getCategorySummary,
  getMonthSummary,
  getWeeklySummary,
} from './db.js';
import { dateYyyyMmDdBogota, formatCop } from './format.js';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Mediodía en America/Bogota como instante UTC (Colombia UTC−5 fijo). */
function bogotaNoonUtcMs(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 17, 0, 0);
}

function bogotaWeekdayMon0(ymd: string): number {
  const w = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Bogota' }).format(
    new Date(bogotaNoonUtcMs(ymd))
  );
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return map[w] ?? 0;
}

function addCalendarDaysBogota(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d, 17, 0, 0) + delta * 86400000;
  return new Date(base).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

/** Lunes a domingo de la semana calendario anterior en Bogotá. */
function previousWeekMonSunBogota(nowUnix: number): { weekStart: string; weekEnd: string } {
  const todayYmd = dateYyyyMmDdBogota(nowUnix);
  const wd = bogotaWeekdayMon0(todayYmd);
  const mondayThisWeek = addCalendarDaysBogota(todayYmd, -wd);
  const mondayPrev = addCalendarDaysBogota(mondayThisWeek, -7);
  const sundayPrev = addCalendarDaysBogota(mondayPrev, 6);
  return { weekStart: mondayPrev, weekEnd: sundayPrev };
}

function addCalendarMonth(y: number, m: number, delta: number): { y: number; m: number } {
  let nm = m + delta;
  let ny = y;
  while (nm < 1) {
    nm += 12;
    ny -= 1;
  }
  while (nm > 12) {
    nm -= 12;
    ny += 1;
  }
  return { y: ny, m: nm };
}

function lastDayOfMonthYyyyMmDd(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad2(month)}-${String(day).padStart(2, '0')}`;
}

function previousCalendarMonthBogota(nowUnix: number): { year: number; month: number; first: string; last: string } {
  const today = dateYyyyMmDdBogota(nowUnix);
  const [y, m] = today.split('-').map(Number);
  const prev = addCalendarMonth(y, m, -1);
  const first = `${prev.y}-${pad2(prev.m)}-01`;
  const last = lastDayOfMonthYyyyMmDd(prev.y, prev.m);
  return { year: prev.y, month: prev.m, first, last };
}

function balanceLineHtml(totalIncome: number, totalExpense: number): string {
  const balance = totalIncome - totalExpense;
  if (balance >= 0) {
    return `💰 Balance: +${formatCop(balance)}`;
  }
  return `💰 Balance: -${formatCop(Math.abs(balance))}`;
}

function diffEmojiForExpense(delta: number): string {
  if (delta > 0) return '📈';
  if (delta < 0) return '📉';
  return '➖';
}

function diffEmojiForIncome(delta: number): string {
  if (delta > 0) return '📈';
  if (delta < 0) return '📉';
  return '➖';
}

function signedCop(delta: number): string {
  if (delta === 0) return formatCop(0);
  if (delta > 0) return `+${formatCop(delta)}`;
  return `-${formatCop(Math.abs(delta))}`;
}

async function delayMs(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function sendWeeklySummaries(bot: Telegraf): Promise<void> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const { weekStart, weekEnd } = previousWeekMonSunBogota(nowUnix);
  const users = await getAllActiveUsers();

  for (const u of users) {
    try {
      const { totalIncome, totalExpense } = await getWeeklySummary(u.id, weekStart, weekEnd);
      if (totalIncome === 0 && totalExpense === 0) continue;

      const balanceLine = balanceLineHtml(totalIncome, totalExpense);
      const inc = formatCop(totalIncome);
      const exp = formatCop(totalExpense);

      let text: string;
      if (u.plan === 'pro') {
        const cats = await getCategorySummary(u.id, weekStart, weekEnd);
        const top = cats.slice(0, 3);
        const topLines =
          top.length > 0
            ? top.map((c) => `  • ${escapeHtml(c.category)}: ${formatCop(c.total)}`).join('\n')
            : '  • (sin gastos por categoría)';
        text =
          '📊 <b>Resumen de la semana</b>\n\n' +
          `📥 Ingresos: ${inc}\n` +
          `📤 Gastos: ${exp}\n` +
          `${balanceLine}\n\n` +
          'Top gastos:\n' +
          topLines;
      } else {
        text =
          '📊 <b>Resumen de la semana</b>\n\n' +
          `📥 Ingresos: ${inc}\n` +
          `📤 Gastos: ${exp}\n` +
          `${balanceLine}\n\n` +
          '💡 Con el plan Pro ves el detalle por categorías — $9.900 COP/mes.';
      }

      await bot.telegram.sendMessage(u.telegram_id, text, { parse_mode: 'HTML' });
    } catch {
      /* continuar con el siguiente usuario */
    }
    await delayMs(100);
  }
}

export async function sendMonthlySummaries(bot: Telegraf): Promise<void> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const prev = previousCalendarMonthBogota(nowUnix);
  const prevPrevYm = addCalendarMonth(prev.year, prev.month, -1);
  const users = await getAllActiveUsers();

  for (const u of users) {
    try {
      const { totalIncome, totalExpense } = await getMonthSummary(u.id, prev.year, prev.month, nowUnix);
      if (totalIncome === 0 && totalExpense === 0) continue;

      const balanceLine = balanceLineHtml(totalIncome, totalExpense);
      const inc = formatCop(totalIncome);
      const exp = formatCop(totalExpense);

      let text: string;
      if (u.plan === 'pro') {
        const cats = await getCategorySummary(u.id, prev.first, prev.last);
        const top = cats.slice(0, 3);
        const topLines =
          top.length > 0
            ? top.map((c) => `  • ${escapeHtml(c.category)}: ${formatCop(c.total)}`).join('\n')
            : '  • (sin gastos por categoría)';

        const prevPrevSummary = await getMonthSummary(u.id, prevPrevYm.y, prevPrevYm.m, nowUnix);
        const gastosDelta = totalExpense - prevPrevSummary.totalExpense;
        const ingresosDelta = totalIncome - prevPrevSummary.totalIncome;

        const vsBlock =
          'vs mes anterior:\n' +
          `  Gastos: ${signedCop(gastosDelta)} ${diffEmojiForExpense(gastosDelta)}\n` +
          `  Ingresos: ${signedCop(ingresosDelta)} ${diffEmojiForIncome(ingresosDelta)}`;

        text =
          '📅 <b>Cierre del mes</b>\n\n' +
          `📥 Ingresos: ${inc}\n` +
          `📤 Gastos: ${exp}\n` +
          `${balanceLine}\n\n` +
          'Top gastos:\n' +
          topLines +
          '\n\n' +
          vsBlock;
      } else {
        text =
          '📅 <b>Cierre del mes</b>\n\n' +
          `📥 Ingresos: ${inc}\n` +
          `📤 Gastos: ${exp}\n` +
          `${balanceLine}\n\n` +
          '💡 Con el plan Pro ves el detalle por categorías y comparación vs mes anterior — $9.900 COP/mes.';
      }

      await bot.telegram.sendMessage(u.telegram_id, text, { parse_mode: 'HTML' });
    } catch {
      /* continuar con el siguiente usuario */
    }
    await delayMs(100);
  }
}
