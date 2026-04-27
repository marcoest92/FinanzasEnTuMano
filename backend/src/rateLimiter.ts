const messageCount = new Map<number, { count: number; resetAt: number }>();

const RATE_LIMIT_MAX = 10; // mensajes por ventana
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minuto

export function isRateLimited(telegramId: number): boolean {
  const now = Date.now();
  const entry = messageCount.get(telegramId);

  if (!entry || now >= entry.resetAt) {
    messageCount.set(telegramId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return false;
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    return true;
  }

  entry.count += 1;
  return false;
}
