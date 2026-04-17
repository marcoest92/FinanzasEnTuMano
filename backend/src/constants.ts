export const FIXED_CATEGORIES = [
  'Arriendo o cuota de vivienda',
  'Servicios públicos',
  'Internet y teléfono',
  'Transporte',
  'Seguros',
  'Deudas / créditos',
  'Alimentación',
  'Salud',
  'Educación',
  'Ropa',
  'Restaurantes',
  'Entretenimiento',
  'Suscripciones',
  'Cuidado personal',
  'Regalos',
  'Ahorro',
  'Inversión',
  'Fondo de emergencia',
  'Imprevistos',
] as const;

export type Category = (typeof FIXED_CATEGORIES)[number];

export const DEFAULT_CATEGORY: Category = 'Imprevistos';

export const WELCOME_MESSAGE = `¡Hola! Soy tu asistente financiero.
Puedes registrar gastos e ingresos escribiendo directamente, por ejemplo:
  • "Almuerzo 15000"
  • "Me pagaron 2 millones"
También puedes enviar notas de voz.
Escribe /dashboard cuando quieras ver tu resumen.`;

export const VOICE_PROCESSING = 'Procesando tu nota de voz...';
export const VOICE_ERROR = 'No pude entender el audio. ¿Puedes escribirlo?';
export const SAVED_MESSAGE = 'Movimiento registrado. ¿Deseas agregar otro?';
