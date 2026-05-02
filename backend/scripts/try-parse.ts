/**
 * Prueba local del parseo (OpenAI) sin Telegram.
 * Uso: npm run try-parse -- "hola"
 *      npm run try-parse -- "almuerzo 15000"
 */
import 'dotenv/config';
import { ASSISTANT_INTRO_MESSAGE } from '../src/constants.js';
import { dateYyyyMmDdBogota } from '../src/format.js';
import { parseTransactionText } from '../src/openai/parseTransaction.js';

const text = process.argv.slice(2).join(' ').trim() || 'hola';
const defaultDate = dateYyyyMmDdBogota(Math.floor(Date.now() / 1000));

const main = async (): Promise<void> => {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Falta OPENAI_API_KEY en .env del backend.');
    process.exit(1);
  }
  const result = await parseTransactionText(text, defaultDate, null);
  console.log('--- JSON parseado ---');
  console.log(JSON.stringify(result, null, 2));
  if (result.intent === 'reminder') {
    console.log('\n--- Recordatorio ---');
    console.log(`Día ${result.day_of_month}: ${result.name}`);
    return;
  }
  if (result.is_greeting) {
    console.log('\n--- Texto que enviaría el bot (saludo) ---');
    console.log(ASSISTANT_INTRO_MESSAGE);
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
