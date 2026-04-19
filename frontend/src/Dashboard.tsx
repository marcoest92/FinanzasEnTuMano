import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { monthRange, currentMonth } from './month';
import { supabase, type DashboardTxRow } from './supabase';

const COLORS = [
  '#2dd4bf',
  '#6366f1',
  '#f97316',
  '#a855f7',
  '#ec4899',
  '#22c55e',
  '#3b82f6',
  '#eab308',
  '#fb7185',
  '#14b8a6',
  '#8b5cf6',
  '#06b6d4',
];

type PieRow = { name: string; value: number; pct: number };

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

function toPieData(map: Map<string, number>, total: number): PieRow[] {
  return [...map.entries()]
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({
      name,
      value,
      pct: total > 0 ? Math.round((value / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

const PIE_MARGIN = { top: 4, right: 4, bottom: 4, left: 4 };

function DonutWithList({ data }: { data: PieRow[] }) {
  if (data.length === 0) return null;
  return (
    <div className="category-block-grid">
      <div className="category-donut">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={PIE_MARGIN}>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius="48%"
              outerRadius="78%"
              paddingAngle={1.5}
              label={(props: { pct?: number; percent?: number }) => {
                const p =
                  props.pct ??
                  (props.percent != null ? Math.round(props.percent * 1000) / 10 : 0);
                return `${p}%`;
              }}
              labelLine={false}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} stroke="transparent" />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number) => formatCop(value)}
              contentStyle={{
                background: '#252a38',
                border: '1px solid #353b4d',
                borderRadius: 10,
              }}
              labelStyle={{ color: '#e8eaef' }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="category-list">
        {data.map((row, i) => (
          <li key={row.name} className="category-list-item">
            <span className="category-dot" style={{ background: COLORS[i % COLORS.length] }} />
            <div className="category-list-text">
              <span className="category-list-name">{row.name}</span>
              <span className="category-list-amount">{formatCop(row.value)}</span>
            </div>
            <span className="category-list-pct">{Math.round(row.pct)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function IconIncome() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14M8 9l4-4 4 4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconExpense() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 5v14m0 0l-4-4m4 4l4-4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconWallet() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4 7a2 2 0 012-2h11a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7z"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path d="M16 12h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function IconHeaderWallet() {
  return (
    <div className="dash-header-icon-wrap" aria-hidden>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
        <path
          d="M4 7a2 2 0 012-2h11a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7z"
          stroke="currentColor"
          strokeWidth="1.75"
        />
        <path d="M16 12h2" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
      </svg>
    </div>
  );
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
    <div className="page dashboard-page">
      <header className="dash-header">
        <div className="dash-header-brand">
          <IconHeaderWallet />
          <div>
            <h1 className="dash-title">Mis Finanzas</h1>
            <p className="dash-subtitle">
              Resumen de ingresos y gastos · {currency} · <span className="dash-month-cap">{label}</span>
            </p>
          </div>
        </div>
        <div className="dash-header-actions">
          <label className="month-field">
            <span className="month-field-label">Período</span>
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
          <button type="button" className="btn-refresh" onClick={() => void load()} disabled={loading}>
            {loading ? '…' : 'Actualizar'}
          </button>
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}

      {loading && rows.length === 0 && !error ? (
        <p className="muted dash-loading">Cargando…</p>
      ) : rows.length === 0 && !error ? (
        <div className="empty">
          <p>No hay movimientos registrados en este período.</p>
          <p>Registra tus gastos e ingresos desde Telegram.</p>
        </div>
      ) : (
        <>
          <section className="kpis dash-kpis">
            <div className="kpi kpi-card kpi-income">
              <div className="kpi-icon-wrap kpi-icon-income">
                <IconIncome />
              </div>
              <div className="kpi-body">
                <span className="kpi-label">Ingresos</span>
                <span className="kpi-value">{formatCop(totalInc)}</span>
              </div>
            </div>
            <div className="kpi kpi-card kpi-expense">
              <div className="kpi-icon-wrap kpi-icon-expense">
                <IconExpense />
              </div>
              <div className="kpi-body">
                <span className="kpi-label">Gastos</span>
                <span className="kpi-value">{formatCop(totalExp)}</span>
              </div>
            </div>
            <div className="kpi kpi-card kpi-balance">
              <div className="kpi-icon-wrap kpi-icon-balance">
                <IconWallet />
              </div>
              <div className="kpi-body">
                <span className="kpi-label">Balance</span>
                <span className={`kpi-value ${balance >= 0 ? 'kpi-val-pos' : 'kpi-val-neg'}`}>
                  {formatCop(balance)}
                </span>
              </div>
            </div>
          </section>

          <section className="category-panel">
            <h2 className="category-panel-title">Gastos por categoría</h2>
            {expensePie.length === 0 ? (
              <p className="muted category-panel-empty">Sin gastos este mes.</p>
            ) : (
              <DonutWithList data={expensePie} />
            )}
          </section>

          <section className="category-panel">
            <h2 className="category-panel-title">Ingresos por categoría</h2>
            {incomePie.length === 0 ? (
              <p className="muted category-panel-empty">Sin ingresos este mes.</p>
            ) : (
              <DonutWithList data={incomePie} />
            )}
          </section>

          <section className="table-section">
            <h2 className="table-section-title">Movimientos del mes</h2>
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
