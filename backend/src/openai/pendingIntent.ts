import { getOpenAI } from './client.js';
import type { PendingPayload } from '../types.js';

export type PendingIntent =
  | { kind: 'correct'; mergedText: string }
  | { kind: 'new_attempt' }
  | { kind: 'chitchat' };

/**
 * Cuando hay pendiente y el mensaje no es sí/no/cancelar, decide si corrige el borrador o intenta un movimiento nuevo.
 */
export async function classifyPendingFollowup(
  userText: string,
  pendingSummary: string
): Promise<PendingIntent> {
  const openai = getOpenAI();
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Tienes un registro pendiente de confirmación del usuario:
${pendingSummary}

El usuario envió un nuevo mensaje. Clasifica:
- "correct": corrige o precisa el registro pendiente (montos, categoría, descripción, tipo). Devuelve mergedText: el TEXTO COMBINADO que mejor describe el movimiento final (incluye correcciones como "en realidad fueron 30000").
- "new_attempt": describe un movimiento financiero distinto/nuevo (otro gasto o ingreso) mientras aún no confirmó el anterior.
- "chitchat": saludos u otros temas sin datos de dinero.

Responde SOLO JSON: {"kind":"correct"|"new_attempt"|"chitchat","mergedText":string|null}
mergedText solo si kind es correct (texto en español para re-parsear).`,
      },
      { role: 'user', content: userText },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) return { kind: 'chitchat' };
  try {
    const j = JSON.parse(raw) as { kind?: string; mergedText?: string | null };
    if (j.kind === 'new_attempt') return { kind: 'new_attempt' };
    if (j.kind === 'correct' && typeof j.mergedText === 'string' && j.mergedText.trim())
      return { kind: 'correct', mergedText: j.mergedText.trim() };
    return { kind: 'chitchat' };
  } catch {
    return { kind: 'chitchat' };
  }
}

export function pendingSummaryFromPayload(p: PendingPayload, amountLabel: string, tipoLabel: string): string {
  return `${tipoLabel} ${amountLabel} en ${p.category}. Descripción: ${p.description}. Fecha: ${p.date}.`;
}
