import type { ReminderIntent } from './types.js';

/** Límite de Telegram para `callback_data` (bytes UTF-8). */
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;

const PREFIX_CONFIRM = 'confirm_reminder:';
const PREFIX_FREQ_REC = 'reminder_freq:recurring';
const PREFIX_FREQ_ONCE = 'reminder_freq:once';

/** JSON compacto para callbacks (sin campo `intent`). */
export function reminderIntentToCompactJson(intent: ReminderIntent): string {
  return JSON.stringify({ n: intent.name, d: intent.day_of_month, c: intent.category });
}

export function compactJsonToReminderIntent(s: string): ReminderIntent | null {
  try {
    const o = JSON.parse(s) as { n?: unknown; d?: unknown; c?: unknown };
    if (typeof o.n !== 'string' || typeof o.d !== 'number' || !Number.isFinite(o.d)) return null;
    const day = Math.round(o.d);
    if (day < 1 || day > 31) return null;
    const c = o.c;
    const category =
      c === null || c === undefined ? null : typeof c === 'string' ? (c.trim() || null) : null;
    return {
      intent: 'reminder',
      name: o.n.trim().slice(0, 300),
      day_of_month: day,
      category,
    };
  } catch {
    return null;
  }
}

export function buildConfirmReminderCallbackData(
  intent: ReminderIntent
): 'confirm_reminder' | `confirm_reminder:${string}` {
  const suffix = reminderIntentToCompactJson(intent);
  const full = `${PREFIX_CONFIRM}${suffix}`;
  if (Buffer.byteLength(full, 'utf8') <= TELEGRAM_CALLBACK_DATA_MAX_BYTES) {
    return full as `confirm_reminder:${string}`;
  }
  return 'confirm_reminder';
}

export function buildFrequencyCallbackData(freq: 'recurring' | 'once', intent: ReminderIntent): string {
  const base = freq === 'recurring' ? PREFIX_FREQ_REC : PREFIX_FREQ_ONCE;
  const suffix = reminderIntentToCompactJson(intent);
  const full = `${base}:${suffix}`;
  if (Buffer.byteLength(full, 'utf8') <= TELEGRAM_CALLBACK_DATA_MAX_BYTES) return full;
  return base;
}
