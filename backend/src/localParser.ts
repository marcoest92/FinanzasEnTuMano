import { DEFAULT_CATEGORY, FIXED_CATEGORIES } from './constants.js';
import type { ParsedTransaction } from './openai/parseTransaction.js';

const CORRECTION_FOLDED = [
  'en realidad',
  'no era',
  'corrigelo',
  'corrige',
  'cambia',
  'cambiar',
];

type CategoryRule = { category: (typeof FIXED_CATEGORIES)[number]; keys: string[] };

/**
 * Cada `category` es un literal de FIXED_CATEGORIES (= CHECK en `transactions.category`).
 * Orden: frases largas / categorías más específicas antes que palabras genéricas (ej. cuota crédito vs cuota).
 */
const CATEGORY_KEYWORDS: CategoryRule[] = [
  {
    category: 'Alimentación',
    keys: [
      'supermercado',
      'restaurante',
      'domicilio',
      'rappi food',
      'ifood',
      'almuerzo',
      'desayuno',
      'cena',
      'cafe',
      'tinto',
      'mercado',
      'comida',
    ],
  },
  {
    category: 'Transporte',
    keys: [
      'transmilenio',
      'parqueadero',
      'gasolina',
      'taxi',
      'uber',
      'cabify',
      'bus',
      'metro',
      'moto',
      'peaje',
      'didi',
    ],
  },
  {
    category: 'Servicios públicos',
    keys: ['codensa', 'energia', 'agua', 'luz', 'gas', 'epm'],
  },
  {
    category: 'Internet y teléfono',
    keys: ['movistar', 'internet', 'celular', 'claro', 'tigo', 'wom', 'plan'],
  },
  {
    category: 'Entretenimiento',
    keys: ['netflix', 'spotify', 'youtube', 'concierto', 'cine', 'juego', 'steam'],
  },
  {
    category: 'Salud',
    keys: ['farmacia', 'drogueria', 'medicina', 'hospital', 'clinica', 'medico', 'doctor', 'droga'],
  },
  {
    category: 'Educación',
    keys: ['universidad', 'colegio', 'udemy', 'curso', 'clase', 'libro'],
  },
  {
    category: 'Cuidado personal',
    keys: ['peluqueria', 'barberia', 'gimnasio', 'gym'],
  },
  {
    category: 'Deudas / créditos',
    keys: ['cuota credito', 'credito', 'prestamo', 'deuda'],
  },
  {
    category: 'Arriendo o cuota de vivienda',
    keys: ['arriendo', 'alquiler', 'cuota'],
  },
  {
    category: 'Suscripciones',
    keys: ['suscripcion', 'membresia', 'premium'],
  },
  {
    category: 'Regalos',
    keys: ['regalo', 'detalle', 'presente'],
  },
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

/** Palabras muy cortas que serían subcadena de otras (ej. gas / gastos). */
function foldedHasKeyword(folded: string, key: string): boolean {
  const k = fold(key);
  if (!k) return false;
  const asWord = new Set(['gas', 'luz', 'agua', 'epm', 'wom', 'tigo', 'gym', 'bus', 'metro', 'moto', 'peaje']);
  if (asWord.has(k)) {
    return new RegExp(`\\b${escapeRe(k)}\\b`).test(folded);
  }
  return folded.includes(k);
}

function categoryFromText(folded: string, type: 'income' | 'expense'): string {
  if (type === 'income' && /\bahorro\b/.test(folded)) {
    return 'Ahorro';
  }
  for (const { category, keys } of CATEGORY_KEYWORDS) {
    for (const k of keys) {
      if (foldedHasKeyword(folded, k)) {
        return category;
      }
    }
  }
  return type === 'income' ? 'Imprevistos' : DEFAULT_CATEGORY;
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

/**
 * Intenta extraer un movimiento obvio sin OpenAI. Devuelve null si no hay certeza.
 */
export function tryLocalParse(text: string, defaultDate: string): ParsedTransaction | null {
  const t = text.trim();
  if (!t) return null;
  if (t.includes('?')) return null;
  if (wordCount(t) > 8) return null;

  const folded = fold(t);
  if (hasCorrectionCue(folded)) return null;

  const candidates = collectAmountCandidates(t);
  const single = pickSingleAmountSpan(candidates);
  if (!single || single.value <= 0) return null;

  const income = containsIncomeKeyword(folded);
  const before = t.slice(0, single.start).trim();
  const after = t.slice(single.end).trim();
  const descriptionJoined = [before, after].filter(Boolean).join(' ').trim();

  if (income) {
    const cat = categoryFromText(folded, 'income');
    const description = descriptionJoined || t.replace(/\s+/g, ' ').trim();
    return buildParsed('income', single.value, description, cat, defaultDate);
  }

  const atEnd = single.end === t.length;
  const atStart = single.start === 0;

  if (atEnd && before.length > 0 && hasLetter(before)) {
    const cat = categoryFromText(fold(before), 'expense');
    return buildParsed('expense', single.value, before, cat, defaultDate);
  }
  if (atStart && after.length > 0 && hasLetter(after)) {
    const cat = categoryFromText(fold(after), 'expense');
    return buildParsed('expense', single.value, after, cat, defaultDate);
  }

  return null;
}
