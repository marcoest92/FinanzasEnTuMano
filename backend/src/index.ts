import 'dotenv/config';
import Fastify from 'fastify';
import { Telegraf } from 'telegraf';
import type { Update } from 'telegraf/types';
import { config } from './config.js';
import {
  handleIncomingText,
  handleVoice,
  handleClarifyExpense,
  handleClarifyIncome,
  handleConfirmYes,
  handleConfirmNo,
  handleConfirmEdit,
} from './messageHandler.js';
import { sendMonthlySummaries, sendWeeklySummaries } from './summaryScheduler.js';

const bot = new Telegraf(config.telegramBotToken());

const CRON_SECRET = process.env.CRON_SECRET ?? '';

bot.on('text', async (ctx) => {
  const t = ctx.message.text;
  if (t === undefined) return;
  await handleIncomingText(ctx, t);
});

bot.on('voice', async (ctx) => {
  await handleVoice(ctx);
});

bot.action('show_summary', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'Próximamente podrás ver el detalle completo aquí. Por ahora escribe /dashboard para ver tu resumen web.'
  );
});

bot.action('show_help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    "Escríbeme cualquier gasto o ingreso en texto o voz. Ejemplo: 'Taxi 8000', 'Mercado 150000', 'Me pagaron el arriendo'. Yo me encargo del resto."
  );
});

bot.action('show_pro_info', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    '💳 Plan Pro — $9.900 COP/mes\n\nEscríbenos a @FinanzasEnTuManoSupp y te activamos el plan en menos de 24 horas.'
  );
});

bot.action('clarify_expense', async (ctx) => {
  await ctx.answerCbQuery();
  await handleClarifyExpense(ctx);
});

bot.action('clarify_income', async (ctx) => {
  await ctx.answerCbQuery();
  await handleClarifyIncome(ctx);
});

bot.action('confirm_yes', async (ctx) => {
  await ctx.answerCbQuery();
  await handleConfirmYes(ctx);
});

bot.action('confirm_no', async (ctx) => {
  await ctx.answerCbQuery();
  await handleConfirmNo(ctx);
});

bot.action('confirm_edit', async (ctx) => {
  await ctx.answerCbQuery();
  await handleConfirmEdit(ctx);
});

const app = Fastify({ logger: true });

app.get('/', async () => ({
  service: 'FinanceBot backend',
  ok: true,
  health: '/health',
  webhook: config.webhookPath,
  hint: 'El dashboard web es el frontend (Vite), normalmente en http://localhost:5173 — no es esta URL.',
}));

app.get('/health', async () => ({ ok: true }));

app.get('/cron/weekly', async (request, reply) => {
  const raw = request.headers['x-cron-secret'];
  const auth = Array.isArray(raw) ? raw[0] : raw;
  if (CRON_SECRET && auth !== CRON_SECRET) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  sendWeeklySummaries(bot).catch((e) => app.log.error(e));
  return reply.code(200).send({ ok: true });
});

app.get('/cron/monthly', async (request, reply) => {
  const raw = request.headers['x-cron-secret'];
  const auth = Array.isArray(raw) ? raw[0] : raw;
  if (CRON_SECRET && auth !== CRON_SECRET) {
    return reply.code(401).send({ error: 'Unauthorized' });
  }
  sendMonthlySummaries(bot).catch((e) => app.log.error(e));
  return reply.code(200).send({ ok: true });
});

app.post(config.webhookPath, async (request, reply) => {
  const secret = config.telegramWebhookSecret;
  if (secret) {
    const header = request.headers['x-telegram-bot-api-secret-token'];
    if (header !== secret) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  }
  const update = request.body as Update;
  try {
    await bot.handleUpdate(update);
  } catch (e) {
    app.log.error(e);
  }
  return reply.code(200).send({ ok: true });
});

const port = config.port;
app.listen({ port, host: '0.0.0.0' }).then(() => {
  app.log.info(`Listening on ${port}, webhook at ${config.webhookPath}`);
});
