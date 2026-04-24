# Qué hacer en Supabase (manual)

El backend ya espera la columna `users.plan` y el RPC `get_dashboard_user` con el campo `plan`. Hasta que apliques lo siguiente en **tu** proyecto de Supabase, las lecturas de usuario pueden fallar.

## Opción 1: SQL Editor (recomendada si no quieres instalar nada más)

1. Entra al [Dashboard de Supabase](https://supabase.com/dashboard) → tu proyecto.
2. Menú **SQL Editor** → **New query**.
3. Abre en tu PC el archivo `supabase/migrations/20260423120000_users_plan.sql`, copia **todo** el contenido y pégalo en el editor.
4. Pulsa **Run**.

Si todo va bien, no debería dar error al volver a ejecutar el script (usa `IF NOT EXISTS` en la columna y `DROP FUNCTION` antes de recrear la función).

## Opción 2: Desde tu PC con el backend

1. En Supabase: **Project Settings** → **Database** → copia la **Connection string** (URI), por ejemplo modo **Transaction** (puerto 6543).
2. En `backend/.env` añade (una sola línea, con tu URI real):

   `SUPABASE_DB_URL=postgresql://...`

3. En terminal:

   ```bash
   cd backend
   npm run db:migrate-users-plan
   ```

## Opción 3: Supabase CLI

Si tienes el proyecto enlazado (`supabase link`):

```bash
npx supabase db push
```

---

Después de migrar, reinicia el backend si ya estaba en marcha. No hace falta cambiar `SUPABASE_URL` ni `SUPABASE_SERVICE_ROLE_KEY`.
