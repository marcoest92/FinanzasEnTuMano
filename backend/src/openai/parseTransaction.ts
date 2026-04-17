import { DEFAULT_CATEGORY, FIXED_CATEGORIES } from '../constants.js';
import { getOpenAI } from './client.js';
import type { PendingPayload, TxType } from '../types.js';

const CATEGORIES_LIST = FIXED_CATEGORIES.join('\n- ');

export interface ParsedTransaction {
  type: TxType | null;
  amount: number | null;
  category: string;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  needs_clarification: boolean;
  clarification_question: string | null;
}

function normalizeCategory(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_CATEGORY;
  const t = raw.trim();
  const exact = FIXED_CATEGORIES.find((c) => c.toLowerCase() === t.toLowerCase());
  if (exact) return exact;
  const partial = FIXED_CATEGORIES.find((c) => t.toLowerCase().includes(c.toLowerCase()) || c.toLowerCase().includes(t.toLowerCase()));
  return partial ?? DEFAULT_CATEGORY;
}

export async function parseTransactionText(
  userText: string,
  defaultDateYyyyMmDd: string,
  existingPending: PendingPayload | null
): Promise<ParsedTransaction> {
  const openai = getOpenAI();
  const defaultDate = defaultDateYyyyMmDd;
  const contextBlock = existingPending
    ? `Hay un borrador pendiente (el usuario está respondiendo a una pregunta o corrigiendo):
${JSON.stringify(existingPending, null, 2)}
Integra la nueva respuesta del usuario y completa tipo/monto/categoría/descripción/fecha.`
    : '';

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Eres un extractor de movimientos financieros en español (Colombia, COP).
Categorías válidas (usa exactamente una de la lista):
- ${CATEGORIES_LIST}

Reglas:
- type: "expense" para gastos/pagos/compras; "income" para ingresos/cobros/sueldo/me pagaron/ventas.
- amount: número en pesos COP (entero). Normaliza expresiones: "2 millones" -> 2000000, "mil" -> 1000, "15000" -> 15000.
- date: ISO YYYY-MM-DD. Si el usuario no dice fecha, usa ${defaultDate} (fecha de hoy del mensaje en contexto).
- description: breve, español.
- Si falta type O amount y no se puede inferir con certeza, pon needs_clarification true y UNA sola clarification_question con opciones claras (ej: ¿Es un gasto o un ingreso? / ¿Cuánto fue exactamente en COP?).
- Si needs_clarification es true, los demás campos pueden ser null o parciales.
${contextBlock}

Responde SOLO JSON con keys: type (null o "income"|"expense"), amount (null o number), category (string), description (string), date (string YYYY-MM-DD), needs_clarification (boolean), clarification_question (null o string).`,
      },
      {
        role: 'user',
        content: userText,
      },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) {
    return {
      type: null,
      amount: null,
      category: DEFAULT_CATEGORY,
      description: userText.slice(0, 200),
      date: defaultDate,
      needs_clarification: true,
      clarification_question: '¿Cuánto fue el movimiento en COP y es gasto o ingreso?',
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {
      type: null,
      amount: null,
      category: DEFAULT_CATEGORY,
      description: userText.slice(0, 200),
      date: defaultDate,
      needs_clarification: true,
      clarification_question: 'No entendí bien. ¿Es gasto o ingreso y de cuánto en COP?',
    };
  }

  const typeRaw = parsed.type;
  const type: TxType | null =
    typeRaw === 'income' || typeRaw === 'expense' ? typeRaw : null;

  const amount =
    typeof parsed.amount === 'number' && Number.isFinite(parsed.amount) && parsed.amount >= 0
      ? Math.round(parsed.amount)
      : null;

  const category = normalizeCategory(typeof parsed.category === 'string' ? parsed.category : undefined);
  const description = typeof parsed.description === 'string' ? parsed.description : userText.slice(0, 300);
  const dateStr =
    typeof parsed.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
      ? parsed.date
      : defaultDate;

  const needs_clarification = Boolean(parsed.needs_clarification);
  const clarification_question =
    typeof parsed.clarification_question === 'string' ? parsed.clarification_question : null;

  // If we still miss required fields, force clarification
  const missingCore = type === null || amount === null;
  if (missingCore && !needs_clarification) {
    return {
      type,
      amount,
      category,
      description,
      date: dateStr,
      needs_clarification: true,
      clarification_question:
        type === null
          ? '¿Es un gasto o un ingreso? Responde con una cifra en COP si falta el monto.'
          : '¿De cuánto fue el movimiento en COP?',
    };
  }

  return {
    type,
    amount,
    category,
    description,
    date: dateStr,
    needs_clarification,
    clarification_question,
  };
}
