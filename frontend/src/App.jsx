import { useState, useCallback, useRef } from 'react';
import './index.css';
import Sidebar      from './components/Sidebar';
import LiveMonitor  from './components/LiveMonitor';
import AlertFeed    from './components/AlertFeed';
import CriminalLog  from './components/CriminalLog';
import EventLog     from './components/EventLog';
import AgentChat    from './components/AgentChat';
import { api }      from './api';

const TABS = [
  { id: 'live',     label: '🎥 Live Monitor' },
  { id: 'alerts',   label: '🚨 Alert Feed' },
  { id: 'criminal', label: '👤 Criminal Log' },
  { id: 'events',   label: '📋 Event Log' },
  { id: 'chat',     label: '💬 Agent Chat' },
];

const TOAST_COLORS = {
  cyan:   { bg: 'rgba(6,182,212,0.15)',   border: '#06B6D4', text: '#38BDF8' },
  green:  { bg: 'rgba(16,185,129,0.15)',  border: '#10B981', text: '#6EE7B7' },
  orange: { bg: 'rgba(249,115,22,0.15)',  border: '#F97316', text: '#FDBA74' },
  red:    { bg: 'rgba(239,68,68,0.15)',   border: '#EF4444', text: '#FCA5A5' },
};

export default function App() {
  const [tab,      setTab]      = useState('live');
  const [running,  setRunning]  = useState(false);
  const [stats,    setStats]    = useState({ frames:0, alerts:0, high:0, criminal:0 });
  const [toasts,   setToasts]   = useState([]);   // array for stacking
  const [wsStatus, setWsStatus] = useState('closed');
  const toastId = useRef(0);

  // ── Toast system ─────────────────────────────────────────────────────────────
  const showToast = useCallback((msg, type = 'cyan', duration = 3000) => {
    const id = ++toastId.current;
    setToasts(prev => [...prev.slice(-3), { id, msg, type }]); // max 4 visible
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration);
  }, []);

  // ── Pipeline controls ─────────────────────────────────────────────────────────
  const handleStart = async (opts) => {
    try {
      const isVideoFile = typeof opts.source === 'string';

      if (isVideoFile) {
        showToast('⚙️ Initiating fast-batch video scan…', 'cyan', 2000);
        await api.analyzeVideo({
          source: opts.source,
          location: opts.location,
          camera_role: opts.camera_role || 'both',
          camera_id: opts.camera_id,
        });
        setRunning(true);
        setStats({ frames: 0, alerts: 0, high: 0, criminal: 0 }); // reset on new session
        showToast('🚀 Batch scanning engine started', 'green');
      } else {
        showToast('🛰️ Engaging surveillance stream…', 'cyan', 2000);
        await api.control({ action: 'start', ...opts });
        setRunning(true);
        setStats({ frames: 0, alerts: 0, high: 0, criminal: 0 }); // reset on new session
        showToast('✅ Neural surveillance matrix online', 'green');
      }
    } catch {
      showToast('❌ Failed to initiate operation — is the server running?', 'red', 5000);
    }
  };

  const handleStop = async () => {
    try {
      await api.control({ action: 'stop' });
      setRunning(false);
      showToast('⏸️ Tactical stream on standby', 'orange');
    } catch {
      showToast('⚠️ Stop command failed', 'red', 4000);
      setRunning(false); // optimistically stop UI
    }
  };

  const handleReset = async () => {
    try {
      showToast('🔄 Purging ingestion buffer…', 'red', 1500);
      await api.control({ action: 'reset' });
      setRunning(false);
      setStats({ frames: 0, alerts: 0, high: 0, criminal: 0 });
      showToast('✅ Buffer purged and reset', 'green');
    } catch {
      showToast('⚠️ Reset command failed', 'red', 4000);
    }
  };

  return (
    <div className="app-layout">

      {/* ── Toast Stack ── */}
      <div className="toast-stack">
        {toasts.map(t => {
          const c = TOAST_COLORS[t.type] || TOAST_COLORS.cyan;
          return (
            <div key={t.id} className="toast-item" style={{
              background:   c.bg,
              border:       `1px solid ${c.border}`,
              boxShadow:    `0 0 22px ${c.border}55`,
              color:        c.text,
            }}>
              <span className="toast-icon">⚡</span>
              <span>{t.msg}</span>
            </div>
          );
        })}
      </div>

      <Sidebar
        running={running}
        wsStatus={wsStatus}
        onStart={handleStart}
        onStop={handleStop}
        onReset={handleReset}
        stats={stats}
        showToast={showToast}
      />

      <div className="main">
        {/* ── Header ── */}
        <div className="page-header">
          <h1>
            🎯 WatchAI
            {running && <span className="live-dot" />}
          </h1>
          <p>Multi-camera AI surveillance · Face Recognition · VLM Scene Analysis · LangGraph Agent</p>
        </div>

        {/* ── Tabs ── */}
        <div className="tab-bar">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`tab-btn ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Tab Content ─────────────────────────────────────────────────────────
            LiveMonitor is ALWAYS mounted (hidden when on other tabs) so the
            WebSocket connection survives tab switches.
        ────────────────────────────────────────────────────────────────────── */}
        <div className="tab-content">
          <div style={{ display: tab === 'live'     ? 'block' : 'none' }}>
            <LiveMonitor
              running={running}
              stats={stats}
              onStats={setStats}
              onWsStatus={setWsStatus}
              showToast={showToast}
            />
          </div>
          {tab === 'alerts'   && <AlertFeed   showToast={showToast} running={running} />}
          {tab === 'criminal' && <CriminalLog showToast={showToast} />}
          {tab === 'events'   && <EventLog    showToast={showToast} />}
          {tab === 'chat'     && <AgentChat   showToast={showToast} />}
        </div>
      </div>
    </div>
  );
}
