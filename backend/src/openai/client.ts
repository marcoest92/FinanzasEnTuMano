import OpenAI from 'openai';
import { config } from '../config.js';

let openai: OpenAI | null = null;

export function getOpenAI(): OpenAI {
  if (!openai) openai = new OpenAI({ apiKey: config.openaiApiKey() });
  return openai;
}
