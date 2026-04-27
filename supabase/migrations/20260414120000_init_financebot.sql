-- FinanceBot MVP: schema, RLS, dashboard RPCs (SECURITY DEFINER)

-- Extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users
CREATE TABLE public.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id bigint NOT NULL UNIQUE,
  currency text NOT NULL DEFAULT 'COP',
  dashboard_token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE en dashboard_token crea índice implícito; no hace falta idx_users_dashboard_token.

-- Transactions
CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('income', 'expense')),
  amount numeric NOT NULL CHECK (amount >= 0),
  category text NOT NULL,
  description text NOT NULL DEFAULT '',
  date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_transactions_user_date ON public.transactions (user_id, date DESC);

-- Pending (one per user)
CREATE TABLE public.pending_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES public.users (id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 hours'),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS: deny direct access for anon; service role bypasses RLS
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pending_transactions ENABLE ROW LEVEL SECURITY;

-- No policies for anon/authenticated on tables = no direct SELECT/INSERT/UPDATE/DELETE via PostgREST for those roles

-- Dashboard: transactions in date range for token holder
CREATE OR REPLACE FUNCTION public.get_dashboard_transactions(
  p_dashboard_token text,
  p_date_from date,
  p_date_to date
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  type text,
  amount numeric,
  category text,
  description text,
  date date,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    t.id,
    t.user_id,
    t.type,
    t.amount,
    t.category,
    t.description,
    t.date,
    t.created_at
  FROM public.transactions t
  INNER JOIN public.users u ON u.id = t.user_id
  WHERE u.dashboard_token = p_dashboard_token
    AND t.date >= p_date_from
    AND t.date <= p_date_to
  ORDER BY t.date DESC, t.created_at DESC;
$$;

-- Optional metadata for dashboard header
CREATE OR REPLACE FUNCTION public.get_dashboard_user(p_dashboard_token text)
RETURNS TABLE (
  currency text,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.currency, u.created_at
  FROM public.users u
  WHERE u.dashboard_token = p_dashboard_token
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_transactions(text, date, date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_transactions(text, date, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_dashboard_user(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_user(text) TO authenticated;
