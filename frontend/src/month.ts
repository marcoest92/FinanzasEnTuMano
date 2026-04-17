export function monthRange(year: number, monthIndex0: number): { from: string; to: string; label: string } {
  const from = new Date(year, monthIndex0, 1);
  const to = new Date(year, monthIndex0 + 1, 0);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const label = from.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
  return { from: fmt(from), to: fmt(to), label };
}

export function currentMonth(): { year: number; monthIndex0: number } {
  const d = new Date();
  return { year: d.getFullYear(), monthIndex0: d.getMonth() };
}
