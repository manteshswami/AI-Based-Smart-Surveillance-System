import { useState, useEffect } from 'react';
import { api } from '../api';

const RISK_COLOR = { CRITICAL: '#EF4444', HIGH: '#F97316', MEDIUM: '#F59E0B', LOW: '#10B981' };

export default function CriminalLog({ showToast }) {
  const [events,  setEvents]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    api.criminals()
      .then(r => { setEvents(r.criminal_events || []); setLoading(false); })
      .catch(() => {
        setError('Failed to load criminal log.');
        showToast('❌ Could not load criminal log', 'red', 4000);
        setLoading(false);
      });
  }, []);

  if (loading) return (
    <div className="empty">
      <div className="loading-dots"><span /><span /><span /></div>
      <div style={{ marginTop: 10 }}>Decrypting biometric dossiers…</div>
    </div>
  );

  if (error) return <div className="empty" style={{ color: '#EF4444' }}>⚠️ {error}</div>;

  if (!events.length) return (
    <div className="empty">
      <span style={{ fontSize: '2.5rem', display: 'block', marginBottom: 12 }}>✅</span>
      No wanted persons sighted in current operational window.
    </div>
  );

  return (
    <div>
      {/* Warning banner */}
      <div style={{
        marginBottom: 18, padding: '12px 18px',
        background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)',
        borderRadius: 12, display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{ fontSize: '1.4rem' }}>⚠️</span>
        <span style={{ color: '#FCA5A5', fontWeight: 700, fontSize: '0.84rem', letterSpacing: '0.03em' }}>
          HIGH SECURITY ALERT — {events.length} watchlist subject{events.length > 1 ? 's' : ''} detected
        </span>
      </div>

      {events.map((e, i) => {
        const level = e.risk_level || 'LOW';
        const col   = RISK_COLOR[level] || '#94A3B8';
        return (
          <div key={i} className="dossier-card slide-in" style={{ borderLeftColor: col }}>
            <div className="dossier-name">
              <span>🚨 {e.criminal_name?.toUpperCase()}</span>
              <span className={`badge ${level}`} style={{ marginLeft: 'auto' }}>RISK: {level}</span>
            </div>
            <div className="dossier-row">
              <div className="dossier-field">
                <span className="lbl">Threat Index</span>
                <span className="val" style={{ color: col, fontSize: '1.1rem', textShadow: `0 0 10px ${col}66` }}>
                  {e.risk_score}/100
                </span>
              </div>
              <div className="dossier-field">
                <span className="lbl">Sighting Sector</span>
                <span className="val">📍 {e.location}</span>
              </div>
              <div className="dossier-field">
                <span className="lbl">Sensor Unit</span>
                <span className="val">📡 {e.camera_id}</span>
              </div>
              <div className="dossier-field">
                <span className="lbl">Timestamp</span>
                <span className="val">⏱️ {e.timestamp?.slice(0, 19).replace('T', ' ')}</span>
              </div>
            </div>
            {e.vlm_description && (
              <div style={{
                marginTop: 14, padding: '10px 14px',
                background: 'rgba(0,0,0,0.3)', borderRadius: 8,
                borderLeft: '2px solid #3B82F6',
                fontSize: '0.84rem', color: '#CBD5E1', fontStyle: 'italic',
              }}>
                &gt; VLM: "{e.vlm_description.slice(0, 180)}{e.vlm_description.length > 180 ? '…' : ''}"
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
