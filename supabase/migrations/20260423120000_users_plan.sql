-- Plan de suscripción por usuario (límites / condiciones en backend según valor).
-- Cómo aplicarlo en el proyecto remoto: ver supabase/PASOS_SUPABASE.md
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'free';

COMMENT ON COLUMN public.users.plan IS 'Tier de producto (ej. free). El backend puede aplicar reglas distintas por plan.';

-- Cabecera del dashboard: incluir plan para la app cuando haga falta.
DROP FUNCTION IF EXISTS public.get_dashboard_user(text);

CREATE FUNCTION public.get_dashboard_user(p_dashboard_token text)
RETURNS TABLE (
  currency text,
  created_at timestamptz,
  plan text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.currency, u.created_at, u.plan
  FROM public.users u
  WHERE u.dashboard_token = p_dashboard_token
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_dashboard_user(text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_dashboard_user(text) TO authenticated;
