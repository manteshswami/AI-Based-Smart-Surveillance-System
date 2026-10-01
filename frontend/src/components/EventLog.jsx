import { useState, useEffect } from 'react';
import { api } from '../api';

export default function EventLog({ showToast }) {
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [search,  setSearch]  = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.events(100);
      setEvents(r.events || []);
    } catch {
      setError('Failed to load event log — server may be offline.');
      showToast('❌ Could not load event log', 'red', 4000);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const downloadCSV = () => {
    const cols = ['frame_id','timestamp','location','camera_id','threat_level','criminal_name','risk_level','risk_score','alert_triggered'];
    const rows = events.map(e => cols.map(c => JSON.stringify(e[c] ?? '')).join(','));
    const csv  = [cols.join(','), ...rows].join('\n');
    const a    = document.createElement('a');
    a.href     = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = `watchai_events_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    showToast('✅ CSV exported', 'green', 2000);
  };

  const filtered = events.filter(e =>
    !search ||
    e.location?.toLowerCase().includes(search.toLowerCase()) ||
    e.criminal_name?.toLowerCase().includes(search.toLowerCase()) ||
    e.threat_level?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div className="filter-row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flex: 1 }}>
          <input
            className="search-input"
            placeholder="🔍 Filter by location, criminal, threat…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <span style={{ fontSize: '0.78rem', color: '#64748B', whiteSpace: 'nowrap' }}>
            {filtered.length} / {events.length} events
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" style={{ width: 'auto', padding: '8px 18px', fontSize: '0.82rem' }} onClick={downloadCSV} disabled={!events.length}>
            ⬇ Export CSV
          </button>
          <button className="btn" style={{ width: 'auto', padding: '8px 14px' }} onClick={load}>↻</button>
        </div>
      </div>

      {loading && (
        <div className="empty">
          <div className="loading-dots"><span /><span /><span /></div>
          <div style={{ marginTop: 10 }}>Querying frame index…</div>
        </div>
      )}
      {!loading && error && <div className="empty" style={{ color: '#EF4444' }}>⚠️ {error}</div>}
      {!loading && !error && filtered.length === 0 && (
        <div className="empty">
          {search ? '🔍 No events match your filter.' : '📭 No events yet — engage a camera stream to populate.'}
        </div>
      )}

      {!loading && !error && filtered.length > 0 && (
        <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid var(--border-subtle)' }}>
          <table className="event-table">
            <thead>
              <tr>
                {['#', 'Timestamp', 'Location', 'Cam', 'Threat', 'Criminal', 'Risk', 'Alert'].map(h => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr key={i}>
                  <td style={{ color: '#38BDF8', fontWeight: 700 }}>#{e.frame_id}</td>
                  <td>{e.timestamp?.slice(0, 19).replace('T', ' ')}</td>
                  <td style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#F1F5F9' }}>
                    {e.location}
                  </td>
                  <td>{e.camera_id}</td>
                  <td><span className={`threat ${e.threat_level}`}>{e.threat_level || 'LOW'}</span></td>
                  <td style={{ color: e.criminal_name ? '#EF4444' : '#475569', fontWeight: e.criminal_name ? 800 : 400 }}>
                    {e.criminal_name ? `⚠ ${e.criminal_name}` : '—'}
                  </td>
                  <td><span className={`threat ${e.risk_level}`}>{e.risk_level} ({e.risk_score})</span></td>
                  <td>
                    {e.alert_triggered
                      ? <span style={{ color: '#EF4444', fontWeight: 700 }}>🚨</span>
                      : <span style={{ color: '#10B981' }}>✓</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
