import { DEFAULT_CATEGORY, FIXED_CATEGORIES, type Category } from './constants.js';
import type { ParsedTransaction } from './openai/parseTransaction.js';
import type { ReminderIntent } from './types.js';

const CORRECTION_FOLDED = [
  'en realidad',
  'no era',
  'corrigelo',
  'corrige',
  'cambia',
  'cambiar',
];

/**
 * Palabras clave → categoría (literales de `FIXED_CATEGORIES` = CHECK en Supabase).
 * Orden: reglas y keywords más específicas antes (ej. `cuota casa` antes de `cuota` en otra regla).
 */
const CATEGORY_KEYWORDS: Array<{ keywords: string[]; category: Category }> = [
  {
    keywords: ['cuota casa', 'arriendo', 'alquiler', 'vivienda', 'hipoteca'],
    category: 'Arriendo o cuota de vivienda',
  },
  {
    keywords: ['luz', 'agua', 'gas', 'epm', 'acueducto', 'electricidad', 'energia'],
    category: 'Servicios públicos',
  },
  {
    keywords: ['internet', 'telefono', 'telefonia', 'claro', 'tigo', 'movistar', 'wifi', 'celular'],
    category: 'Internet y teléfono',
  },
  {
    keywords: ['taxi', 'uber', 'bus', 'metro', 'transporte', 'gasolina', 'peaje', 'transmilenio', 'indriver'],
    category: 'Transporte',
  },
  { keywords: ['seguro', 'axa', 'sura', 'seguros'], category: 'Seguros' },
  { keywords: ['deuda', 'credito', 'prestamo', 'cuota', 'banco', 'tarjeta'], category: 'Deudas / créditos' },
  {
    keywords: ['mercado', 'supermercado', 'comida', 'alimentacion', 'drogueria', 'exito', 'jumbo', 'rappi'],
    category: 'Alimentación',
  },
  {
    keywords: ['medico', 'medicina', 'salud', 'farmacia', 'clinica', 'hospital', 'eps', 'cita'],
    category: 'Salud',
  },
  {
    keywords: ['colegio', 'universidad', 'educacion', 'curso', 'matricula', 'estudio'],
    category: 'Educación',
  },
  { keywords: ['ropa', 'zapatos', 'ropa interior', 'vestido'], category: 'Ropa' },
  {
    keywords: ['restaurante', 'almuerzo', 'cena', 'desayuno', 'cafe', 'pizza', 'hamburguesa', 'hamburgesa'],
    category: 'Restaurantes',
  },
  {
    keywords: ['cine', 'concierto', 'entretenimiento', 'juego', 'videojuego'],
    category: 'Entretenimiento',
  },
  {
    keywords: ['netflix', 'spotify', 'amazon', 'disney', 'hbo', 'suscripcion', 'prime', 'membresia', 'premium'],
    category: 'Suscripciones',
  },
  { keywords: ['barberia', 'peluqueria', 'estetica', 'spa', 'cuidado personal'], category: 'Cuidado personal' },
  { keywords: ['regalo', 'regalos'], category: 'Regalos' },
  { keywords: ['ahorro'], category: 'Ahorro' },
  { keywords: ['inversion', 'acciones', 'fondos'], category: 'Inversión' },
  { keywords: ['fondo emergencia', 'emergencia'], category: 'Fondo de emergencia' },
];

function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function hasCorrectionCue(folded: string): boolean {
  return CORRECTION_FOLDED.some((p) => folded.includes(p));
}

function parseDecimalToken(raw: string): number {
  const t = raw.replace(',', '.');
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    return Math.round(Number(t.replace(/\./g, '')));
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

type AmountSpan = { start: number; end: number; value: number };

function overlaps(a: AmountSpan, b: AmountSpan): boolean {
  return !(a.end <= b.start || a.start >= b.end);
}

function collectAmountCandidates(s: string): AmountSpan[] {
  const candidates: AmountSpan[] = [];

  const run = (re: RegExp, fn: (m: RegExpExecArray) => { start: number; end: number; value: number } | null) => {
    const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    while ((m = r.exec(s)) !== null) {
      const mapped = fn(m);
      if (mapped && mapped.value > 0 && Number.isFinite(mapped.value)) candidates.push(mapped);
    }
  };

  run(/\bmedio\s+mill[oó]n\b/gi, (m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
    value: 500_000,
  }));

  run(/\b(\d+(?:[.,]\d+)?)\s+millones\b/gi, (m) => {
    const v = parseDecimalToken(m[1]!);
    if (!Number.isFinite(v)) return null;
    return { start: m.index!, end: m.index! + m[0].length, value: Math.round(v * 1_000_000) };
  });

  run(/\b(\d+(?:[.,]\d+)?)\s+mill[oó]n\b/gi, (m) => {
    const v = parseDecimalToken(m[1]!);
    if (!Number.isFinite(v)) return null;
    return { start: m.index!, end: m.index! + m[0].length, value: Math.round(v * 1_000_000) };
  });

  run(/\b(un|1)\s+mill[oó]n(es)?\b/gi, (m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
    value: 1_000_000,
  }));

  run(/\b1\s*mill[oó]n(es)?\b/gi, (m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
    value: 1_000_000,
  }));

  run(/\b1mill[oó]n(es)?\b/gi, (m) => ({
    start: m.index!,
    end: m.index! + m[0].length,
    value: 1_000_000,
  }));

  run(/\b(\d+(?:[.,]\d+)?)\s+mil\b/gi, (m) => {
    const v = parseDecimalToken(m[1]!);
    if (!Number.isFinite(v)) return null;
    return { start: m.index!, end: m.index! + m[0].length, value: Math.round(v * 1000) };
  });

  run(/\b(\d+(?:[.,]\d+)?)\s*k\b/gi, (m) => {
    const v = parseDecimalToken(m[1]!);
    if (!Number.isFinite(v)) return null;
    return { start: m.index!, end: m.index! + m[0].length, value: Math.round(v * 1000) };
  });

  run(/\b(\d+(?:[.,]\d+)?)\b/g, (m) => {
    const v = parseDecimalToken(m[0]!);
    if (!Number.isFinite(v) || v <= 0) return null;
    return { start: m.index!, end: m.index! + m[0].length, value: Math.round(v) };
  });

  return candidates;
}

/** Deja un solo monto: prioriza spans más largos y exige que no queden dos cantidades separadas. */
function pickSingleAmountSpan(candidates: AmountSpan[]): AmountSpan | null {
  const sorted = [...candidates].sort((a, b) => b.end - b.start - (a.end - a.start));
  const picked: AmountSpan[] = [];
  for (const sp of sorted) {
    if (picked.some((p) => overlaps(sp, p))) continue;
    picked.push(sp);
  }
  if (picked.length !== 1) return null;
  return picked[0]!;
}

function containsIncomeKeyword(foldedFull: string): boolean {
  if (/\btransferencia\s+recibida\b/.test(foldedFull)) return true;
  if (/\bme\s+consignaron\b/.test(foldedFull)) return true;
  const w = [
    'pagaron',
    'cobre',
    'entro',
    'recibi',
    'sueldo',
    'quincena',
    'salario',
  ] as const;
  for (const x of w) {
    if (new RegExp(`\\b${x}\\b`).test(foldedFull)) return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeForCategoryInfer(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Evita coincidencias por subcadena (ej. "gas" dentro de "gastos"). */
const KEYWORD_REQUIRES_WORD_BOUNDARY = new Set([
  'gas',
  'luz',
  'agua',
  'epm',
  'wom',
  'tigo',
  'gym',
  'bus',
  'metro',
  'moto',
  'peaje',
  'ropa',
  'eps',
  'rappi',
  'sura',
  'axa',
]);

function keywordMatchesInNormalizedText(textNorm: string, keywordRaw: string): boolean {
  const kw = normalizeForCategoryInfer(keywordRaw);
  if (!kw) return false;
  if (kw.includes(' ') || kw.length > 18) {
    return textNorm.includes(kw);
  }
  if (KEYWORD_REQUIRES_WORD_BOUNDARY.has(kw)) {
    return new RegExp(`\\b${escapeRe(kw)}\\b`).test(textNorm);
  }
  return textNorm.includes(kw);
}

export function inferCategoryLocal(text: string): Category | null {
  const n = normalizeForCategoryInfer(text);
  for (const { keywords, category } of CATEGORY_KEYWORDS) {
    for (const kw of keywords) {
      if (keywordMatchesInNormalizedText(n, kw)) return category;
    }
  }
  return null;
}

function categoryFromText(source: string, type: 'income' | 'expense'): string {
  return inferCategoryLocal(source) ?? (type === 'income' ? 'Imprevistos' : DEFAULT_CATEGORY);
}

function buildParsed(
  type: 'income' | 'expense',
  amount: number,
  description: string,
  category: string,
  defaultDate: string
): ParsedTransaction {
  const cat =
    (FIXED_CATEGORIES as readonly string[]).find((c) => c.toLowerCase() === category.toLowerCase()) ??
    DEFAULT_CATEGORY;
  return {
    is_greeting: false,
    type,
    amount,
    category: cat,
    description: description.trim().slice(0, 300),
    date: defaultDate,
    needs_clarification: false,
    clarification_question: null,
  };
}

function hasLetter(s: string): boolean {
  return /\p{L}/u.test(s);
}

function parseDayOfMonth1To31(s: string): number | null {
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1 || n > 31) return null;
  return n;
}

/** Quita sufijos "por …" (monto) del nombre del recordatorio. */
function stripTrailingPorClause(s: string): string {
  return s.replace(/\s+por\b[\s\S]*$/iu, '').trim();
}

/** Limpia el nombre: sin palabras clave de recordatorio, sin dobles espacios. */
function cleanReminderName(raw: string): string {
  let n = stripTrailingPorClause(raw);
  n = n
    .replace(/\brecordatorio\b/giu, ' ')
    .replace(/\brecordarme\b/giu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n.slice(0, 300);
}

/**
 * Detecta recordatorio mensual: palabra clave + texto + "el" + día, o texto + "el" + día (pago recurrente).
 */
function tryLocalReminderIntent(text: string): ReminderIntent | null {
  const t = text.trim();
  if (!t || t.includes('?')) return null;

  const folded = fold(t);
  if (hasCorrectionCue(folded)) return null;

  const dayElRest = /^(.+?)\s+el\s+(\d{1,2})\b(?:\s+por\b[\s\S]*)?$/iu;
  const hasKeyword = /\brecordatorio\b/u.test(folded) || /\brecordarme\b/u.test(folded);

  let subject: string;
  let dayStr: string;

  if (hasKeyword) {
    const afterKw = t.replace(/^\s*(recordatorio|recordarme)\s+/iu, '').trim();
    const m = afterKw.match(dayElRest);
    if (!m) return null;
    subject = m[1]!.trim();
    dayStr = m[2]!;
  } else {
    if (containsIncomeKeyword(folded)) return null;
    const m = t.match(dayElRest);
    if (!m) return null;
    subject = m[1]!.trim();
    dayStr = m[2]!;
  }

  const day = parseDayOfMonth1To31(dayStr);
  if (day === null) return null;

  const name = cleanReminderName(subject);
  if (!name || !hasLetter(name)) return null;

  return {
    intent: 'reminder',
    name,
    day_of_month: day,
    category: inferCategoryLocal(name) ?? null,
  };
}

export type LocalParseResult = ReminderIntent | ParsedTransaction | null;

export function isLocalReminderIntent(r: LocalParseResult): r is ReminderIntent {
  return r != null && 'intent' in r && r.intent === 'reminder';
}

/**
 * Intenta extraer un movimiento obvio sin OpenAI. Devuelve null si no hay certeza.
 */
export function tryLocalParse(text: string, defaultDate: string): LocalParseResult {
  const t = text.trim();
  if (!t) return null;
  if (t.includes('?')) return null;

  const foldedEarly = fold(t);
  if (hasCorrectionCue(foldedEarly)) return null;

  const reminder = tryLocalReminderIntent(t);
  if (reminder) return reminder;

  if (wordCount(t) > 8) return null;

  const folded = foldedEarly;

  const candidates = collectAmountCandidates(t);
  const single = pickSingleAmountSpan(candidates);
  if (!single || single.value <= 0) return null;

  const income = containsIncomeKeyword(folded);
  const before = t.slice(0, single.start).trim();
  const after = t.slice(single.end).trim();
  const descriptionJoined = [before, after].filter(Boolean).join(' ').trim();

  if (income) {
    const description = descriptionJoined || t.replace(/\s+/g, ' ').trim();
    const cat = categoryFromText(description, 'income');
    return buildParsed('income', single.value, description, cat, defaultDate);
  }

  const atEnd = single.end === t.length;
  const atStart = single.start === 0;

  if (atEnd && before.length > 0 && hasLetter(before)) {
    const cat = categoryFromText(before, 'expense');
    return buildParsed('expense', single.value, before, cat, defaultDate);
  }
  if (atStart && after.length > 0 && hasLetter(after)) {
    const cat = categoryFromText(after, 'expense');
    return buildParsed('expense', single.value, after, cat, defaultDate);
  }

  return null;
}
