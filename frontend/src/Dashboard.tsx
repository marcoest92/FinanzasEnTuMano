import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { monthRange, currentMonth } from './month';
import { supabase, type DashboardTxRow } from './supabase';

const COLORS = [
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
];

function formatCop(n: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
}

function aggregateByCategory(rows: DashboardTxRow[], type: 'expense' | 'income') {
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.type !== type) continue;
    map.set(r.category, (map.get(r.category) ?? 0) + Number(r.amount));
  }
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  return { map, total };
}

function toPieData(map: Map<string, number>, total: number) {
  return [...map.entries()]
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({
      name,
      value,
      pct: total > 0 ? Math.round((value / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

export function Dashboard() {
  const { token } = useParams<{ token: string }>();
  const [year, setYear] = useState(() => currentMonth().year);
  const [monthIndex0, setMonthIndex0] = useState(() => currentMonth().monthIndex0);
  const [rows, setRows] = useState<DashboardTxRow[]>([]);
  const [currency, setCurrency] = useState<string>('COP');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { from, to, label } = useMemo(() => monthRange(year, monthIndex0), [year, monthIndex0]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    const { data: userRows, error: userErr } = await supabase.rpc('get_dashboard_user', {
      p_dashboard_token: token,
    });
    if (userErr) {
      setError(userErr.message);
      setLoading(false);
      return;
    }
    const list = Array.isArray(userRows) ? userRows : [];
    if (list.length === 0) {
      setError('Este enlace no es válido o el token ha cambiado.');
      setLoading(false);
      return;
    }
    const u = list[0];
    if (u && typeof u === 'object' && 'currency' in u) {
      setCurrency(String((u as { currency: string }).currency));
    }

    const { data, error: txErr } = await supabase.rpc('get_dashboard_transactions', {
      p_dashboard_token: token,
      p_date_from: from,
      p_date_to: to,
    });
    if (txErr) {
      setError(txErr.message);
      setLoading(false);
      return;
    }
    setRows((data as DashboardTxRow[]) ?? []);
    setLoading(false);
  }, [token, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const expenseAgg = useMemo(() => aggregateByCategory(rows, 'expense'), [rows]);
  const incomeAgg = useMemo(() => aggregateByCategory(rows, 'income'), [rows]);
  const totalExp = expenseAgg.total;
  const totalInc = incomeAgg.total;
  const balance = totalInc - totalExp;

  const expensePie = useMemo(
    () => toPieData(expenseAgg.map, expenseAgg.total),
    [expenseAgg]
  );
  const incomePie = useMemo(() => toPieData(incomeAgg.map, incomeAgg.total), [incomeAgg]);

  if (!token) {
    return <div className="page">Falta el token en la URL.</div>;
  }

  return (
    <div className="page">
      <header className="header">
        <h1>FinanceBot</h1>
        <p className="sub">Moneda: {currency}</p>
      </header>

      <section className="toolbar">
        <label>
          Mes
          <input
            type="month"
            value={`${year}-${String(monthIndex0 + 1).padStart(2, '0')}`}
            onChange={(e) => {
              const v = e.target.value;
              const [y, m] = v.split('-').map(Number);
              setYear(y);
              setMonthIndex0(m - 1);
            }}
          />
        </label>
        <span className="month-label">{label}</span>
      </section>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <p className="muted">Cargando…</p>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p>No hay movimientos registrados en este período.</p>
          <p>Registra tus gastos e ingresos desde Telegram.</p>
        </div>
      ) : (
        <>
          <section className="kpis">
            <div className="kpi">
              <span className="kpi-label">Total gastos</span>
              <span className="kpi-value expense">{formatCop(totalExp)}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Total ingresos</span>
              <span className="kpi-value income">{formatCop(totalInc)}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Balance</span>
              <span className={`kpi-value ${balance >= 0 ? 'income' : 'expense'}`}>{formatCop(balance)}</span>
            </div>
          </section>

          <div className="charts">
            <div className="chart-card">
              <h2>Gastos por categoría</h2>
              {expensePie.length === 0 ? (
                <p className="muted">Sin gastos este mes.</p>
              ) : (
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie
                        data={expensePie}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        label={({ name, pct }) => `${name} (${pct}%)`}
                      >
                        {expensePie.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number) => formatCop(v)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
            <div className="chart-card">
              <h2>Ingresos por categoría</h2>
              {incomePie.length === 0 ? (
                <p className="muted">Sin ingresos este mes.</p>
              ) : (
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height={280}>
                    <PieChart>
                      <Pie
                        data={incomePie}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="50%"
                        outerRadius={100}
                        label={({ name, pct }) => `${name} (${pct}%)`}
                      >
                        {incomePie.map((_, i) => (
                          <Cell key={i} fill={COLORS[i % COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v: number) => formatCop(v)} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>
          </div>

          <section className="table-section">
            <h2>Movimientos del mes</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Fecha</th>
                    <th>Tipo</th>
                    <th>Categoría</th>
                    <th>Descripción</th>
                    <th className="num">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.date}</td>
                      <td>{r.type === 'expense' ? 'Gasto' : 'Ingreso'}</td>
                      <td>{r.category}</td>
                      <td>{r.description}</td>
                      <td className="num">{formatCop(Number(r.amount))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
