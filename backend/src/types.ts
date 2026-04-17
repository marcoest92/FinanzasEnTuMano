export type TxType = 'income' | 'expense';

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
