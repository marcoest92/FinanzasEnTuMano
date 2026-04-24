export type TxType = 'income' | 'expense';

/** Valores de `users.plan`; ampliar el union cuando existan más planes en DB. */
export type UserPlan = 'free';

/** Valor por defecto al crear usuario (coincide con DEFAULT en Postgres). */
export const DEFAULT_USER_PLAN: UserPlan = 'free';

export interface PendingPayload {
  type?: TxType;
  amount?: number;
  category: string;
  description: string;
  /** YYYY-MM-DD */
  date: string;
  /** True mientras falta tipo/monto y el bot hizo una pregunta */
  awaiting_clarification?: boolean;
}
