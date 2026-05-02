export type TxType = 'income' | 'expense';

/** Valores de `users.plan`; ampliar el union cuando existan más planes en DB. */
export type UserPlan = 'free' | 'pro';

/** Valor por defecto al crear usuario (coincide con DEFAULT en Postgres). */
export const DEFAULT_USER_PLAN: UserPlan = 'free';

export interface ReminderIntent {
  intent: 'reminder';
  name: string;
  day_of_month: number;
  category: string | null;
}

export interface PendingPayload {
  type?: TxType;
  amount?: number;
  category: string;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  /** True mientras falta tipo/monto y el bot hizo una pregunta */
  awaiting_clarification?: boolean;
  /** Borrador de recordatorio (flujo de confirmación / frecuencia). */
  reminder_draft?: ReminderIntent;
  /** `confirm` = esperando Guardar/Corregir/Cancelar; `frequency` = esperando mensual vs una vez. */
  reminder_phase?: 'confirm' | 'frequency';
  /** Usuario pulsó "Pagado" en notificación de recordatorio; esperamos solo el monto en COP. */
  awaiting_reminder_payment?: {
    reminder_id: string;
    reminder_name: string;
    category: string | null;
    recurring: boolean;
  };
}

export interface Reminder {
  id: string;
  user_id: string;
  name: string;
  day_of_month: number;
  amount: number | null;
  category: string | null;
  recurring: boolean;
  created_at: string;
}

export interface ReminderLog {
  id: string;
  reminder_id: string;
  user_id: string;
  year_month: string;
  paid: boolean;
  paid_at: string | null;
  transaction_id: string | null;
  created_at: string;
}
