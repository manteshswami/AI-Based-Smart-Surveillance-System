import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

export default function AlertFeed({ showToast, running }) {
  const [alerts,   setAlerts]   = useState([]);
  const [severity, setSeverity] = useState('');
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);
  const prevCount = useRef(0);
  const autoTimer = useRef(null);

  const load = async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await api.alerts(severity, 50);
      const newAlerts = res.alerts || [];
      // Toast only when new alerts appear during auto-refresh
      if (silent && newAlerts.length > prevCount.current) {
        showToast(`🚨 ${newAlerts.length - prevCount.current} new alert(s) detected`, 'red', 4000);
      }
      prevCount.current = newAlerts.length;
      setAlerts(newAlerts);
    } catch {
      setError('Failed to load alerts — server may be offline.');
      if (!silent) showToast('❌ Failed to load alerts', 'red', 4000);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  // Load on mount + whenever severity filter changes
  useEffect(() => { load(); }, [severity]);

  // Auto-refresh every 15s while running
  useEffect(() => {
    clearInterval(autoTimer.current);
    if (running) {
      autoTimer.current = setInterval(() => load(true), 15000);
    }
    return () => clearInterval(autoTimer.current);
  }, [running, severity]);

  const SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
  const sorted = [...alerts].sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));

  return (
    <div>
      <div className="filter-row">
        <span style={{ fontSize: '0.85rem', color: '#06B6D4', fontWeight: 700, letterSpacing: '0.04em' }}>
          🚨 SEVERITY GATE:
        </span>
        <select
          className="filter-select"
          value={severity}
          onChange={e => setSeverity(e.target.value)}
        >
          <option value="">All Infractions</option>
          <option value="CRITICAL">CRITICAL ONLY</option>
          <option value="HIGH">HIGH ONLY</option>
          <option value="MEDIUM">MEDIUM ONLY</option>
          <option value="LOW">LOW ONLY</option>
        </select>
        <button className="btn" style={{ width: 'auto', padding: '8px 18px' }} onClick={() => load()}>
          ↻ SYNC
        </button>
        {running && (
          <span style={{ fontSize: '0.72rem', color: '#64748B', fontFamily: 'var(--font-mono)', marginLeft: 4 }}>
            Auto-refresh every 15s
          </span>
        )}
        {alerts.length > 0 && (
          <span className="badge HIGH" style={{ marginLeft: 'auto' }}>
            {alerts.length} alerts
          </span>
        )}
      </div>

      {loading && (
        <div className="empty">
          <div className="loading-dots"><span /><span /><span /></div>
          <div style={{ marginTop: 10 }}>Loading alert feed…</div>
        </div>
      )}
      {!loading && error && (
        <div className="empty" style={{ color: '#EF4444' }}>⚠️ {error}</div>
      )}
      {!loading && !error && sorted.length === 0 && (
        <div className="empty">✅ No security infractions detected.</div>
      )}

      {!loading && sorted.map((a, i) => (
        <div key={i} className={`alert-card ${a.severity} slide-in`}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span className={`badge ${a.severity}`}>{a.severity}</span>
            <span style={{ fontSize: '0.73rem', color: '#64748B', fontFamily: 'var(--font-mono)' }}>
              {a.rule_name}
            </span>
          </div>
          <div style={{ fontSize: '0.92rem', color: '#F8FAFC', fontWeight: 600, marginBottom: 8, lineHeight: 1.55 }}>
            {a.alert_text}
          </div>
          <div className="alert-meta">
            📍 {a.location}&nbsp;│&nbsp;
            📡 {a.camera_id}&nbsp;│&nbsp;
            ⏱️ {a.timestamp?.slice(0, 19).replace('T', ' ')}
            {a.criminal && (
              <span style={{ color: '#EF4444', fontWeight: 700 }}>
                &nbsp;│&nbsp;🚨 {a.criminal}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
