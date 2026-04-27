/** Formato tipo $25.000 COP (es-CO) */
export function formatCop(amount: number): string {
  const n = Math.round(amount);
  const s = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(n);
  return `$${s} COP`;
}

export function formatDateDdMmYyyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

export function parseLocalDate(yyyyMmDd: string): Date {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Fecha calendario YYYY-MM-DD en zona Bogotá para un instante Unix (Telegram message.date). */
export function dateYyyyMmDdBogota(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

/** Primer día del mes calendario actual en America/Bogota, formato YYYY-MM-DD. */
export function firstDayOfCurrentMonthBogota(nowUnixSeconds: number = Math.floor(Date.now() / 1000)): string {
  const today = dateYyyyMmDdBogota(nowUnixSeconds);
  const [y, m] = today.split('-');
  return `${y}-${m}-01`;
}
