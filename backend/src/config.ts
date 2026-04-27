function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

export const config = {
  telegramBotToken: () => req('TELEGRAM_BOT_TOKEN'),
  openaiApiKey: () => req('OPENAI_API_KEY'),
  supabaseUrl: () => req('SUPABASE_URL'),
  supabaseServiceRoleKey: () => req('SUPABASE_SERVICE_ROLE_KEY'),
  /** Public URL of the web app, e.g. https://app.example.com */
  dashboardPublicUrl: () => process.env.DASHBOARD_PUBLIC_URL?.replace(/\/$/, '') ?? 'http://localhost:5173',
  webhookPath: process.env.WEBHOOK_PATH ?? '/webhook',
  port: Number(process.env.PORT ?? 3000),
  telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  /** Secreto opcional para POST /cron/weekly y /cron/monthly (header x-cron-secret). */
  cronSecret: process.env.CRON_SECRET ?? '',
};
