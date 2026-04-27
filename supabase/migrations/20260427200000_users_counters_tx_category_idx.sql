-- Contadores / plan en users; CHECK de categoría en transactions; índice mensual; quita índice duplicado en dashboard_token.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS plan_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS monthly_tx_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS monthly_tx_reset_at date NOT NULL DEFAULT (date_trunc('month', now())::date);

COMMENT ON COLUMN public.users.plan_expires_at IS 'Vencimiento plan Pro; NULL en free.';
COMMENT ON COLUMN public.users.monthly_tx_count IS 'Transacciones registradas en el mes del contador.';
COMMENT ON COLUMN public.users.monthly_tx_reset_at IS 'Inicio del mes calendario asociado al contador mensual.';

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_category_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_category_check CHECK (
    category IN (
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
      'Imprevistos'
    )
  );

DROP INDEX IF EXISTS public.idx_users_dashboard_token;

CREATE INDEX IF NOT EXISTS idx_transactions_user_month
  ON public.transactions (user_id, (date_trunc('month', date::timestamp)));
