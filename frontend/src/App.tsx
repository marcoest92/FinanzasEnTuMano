import { HashRouter, Route, Routes } from 'react-router-dom';
import { Dashboard } from './Dashboard';

export function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/dashboard/:token" element={<Dashboard />} />
        <Route
          path="/"
          element={
            <div className="page home-landing">
              <p>FinanceBot — abre el enlace que te envía el bot en Telegram (incluye tu token).</p>
            </div>
          }
        />
      </Routes>
    </HashRouter>
  );
}
