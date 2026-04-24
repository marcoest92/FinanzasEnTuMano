# Secretos y variables (GitHub + despliegue)

Las API keys y tokens **no** deben estar en el código ni en commits. Úsalos solo como **Secrets** (GitHub Actions / tu hosting) o en un `.env` local (ya está en `.gitignore`).

## GitHub: Repository secrets

Ruta: **Settings → Secrets and variables → Actions → New repository secret**

Crea estos secretos con el **mismo nombre** que la variable de entorno (el workflow de CI y cualquier deploy los leerán así):

| Nombre del secret | Uso |
|-------------------|-----|
| `TELEGRAM_BOT_TOKEN` | Backend: bot de Telegram |
| `OPENAI_API_KEY` | Backend: OpenAI |
| `SUPABASE_URL` | Backend: URL del proyecto Supabase |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend: **solo servidor** (nunca en el frontend) |
| `TELEGRAM_WEBHOOK_SECRET` | Opcional: mismo valor que `secret_token` en `setWebhook` |
| `SUPABASE_DB_URL` | Opcional: URI Postgres para `npm run db:migrate-users-plan` en CI |
| `VITE_SUPABASE_URL` | Build del frontend (público en el bundle; igual conviene no hardcodearlo) |
| `VITE_SUPABASE_ANON_KEY` | Build del frontend (clave anon; diseñada para cliente con RLS) |
| `DASHBOARD_PUBLIC_URL` | Opcional: URL pública del dashboard (ej. `https://tu-dominio.com`) |

**Variables** (no sensibles): en la misma pantalla puedes usar **Variables** para `DASHBOARD_PUBLIC_URL` o `WEBHOOK_PATH` si prefieres que no estén marcadas como “secret”.

## Proyecto en tu plataforma de hosting

Donde despliegues el **backend** (Railway, Render, Fly.io, VPS, etc.), configura las mismas claves como **Environment variables** / **Secrets** del servicio, no en el repositorio:

- `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
- Opcionales: `TELEGRAM_WEBHOOK_SECRET`, `PORT`, `WEBHOOK_PATH`, `DASHBOARD_PUBLIC_URL`

En el **frontend** (Vite en Netlify, Vercel, Cloudflare Pages, etc.):

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

## Supabase (panel del proyecto)

- **Project Settings → API**: URL y anon para el frontend; `service_role` solo en backend.
- **Database → Database password**: para `SUPABASE_DB_URL` o migraciones; no lo subas al repo.

## Cursor u otro IDE

Las claves van en `backend/.env` y `frontend/.env` **locales** (ignorados por git). No uses el chat ni captures de pantalla con valores reales.

## Si una clave llegó a subirse por error

Rótala en Telegram (BotFather), OpenAI y Supabase y actualiza los secrets en GitHub y en el hosting.
