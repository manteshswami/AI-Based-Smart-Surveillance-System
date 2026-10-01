import { useState, useEffect, useRef, useCallback } from 'react';
import { createReconnectingSocket } from '../api';

const THREAT_COLOR = {
  HIGH:     '#F97316',
  MEDIUM:   '#F59E0B',
  LOW:      '#10B981',
  CRITICAL: '#EF4444',
};

// FPS counter over a sliding 3-second window
function useFpsCounter(running) {
  const [fps, setFps] = useState(0);
  const times = useRef([]);

  const tick = useCallback(() => {
    const now = Date.now();
    times.current = times.current.filter(t => now - t < 3000);
    times.current.push(now);
    setFps(Math.round(times.current.length / 3));
  }, []);

  useEffect(() => {
    if (!running) { setFps(0); times.current = []; }
  }, [running]);

  return { fps, tick };
}

export default function LiveMonitor({ running, stats, onStats, onWsStatus, showToast }) {
  const [frame,         setFrame]         = useState(null);
  const [event,         setEvent]         = useState(null);
  const [wsStatus,      setWsStatus]      = useState('closed');
  const [lastSeen,      setLastSeen]      = useState(null);
  const [batchProgress, setBatchProgress] = useState(null);
  const [batchEvents,   setBatchEvents]   = useState([]);
  const [batchComplete, setBatchComplete] = useState(false);
  const socketRef   = useRef(null);
  const { fps, tick } = useFpsCounter(running);

  // Sync wsStatus up to App
  const updateStatus = useCallback((s) => {
    setWsStatus(s);
    onWsStatus?.(s);
  }, [onWsStatus]);

  // Reset states on session end
  useEffect(() => {
    if (!running) {
      setFrame(null);
      setEvent(null);
      setBatchProgress(null);
      setBatchEvents([]);
      setBatchComplete(false);
    }
  }, [running]);

  useEffect(() => {
    if (!running) {
      socketRef.current?.close();
      socketRef.current = null;
      updateStatus('closed');
      return;
    }

    socketRef.current = createReconnectingSocket(
      // onMessage
      (data) => {
        if (data.type === 'batch_progress') {
          setBatchProgress({ percent: data.percent, phase: data.phase });
          return;
        }
        if (data.type === 'batch_complete') {
          setBatchProgress(null);
          setBatchComplete(true);
          setBatchEvents(data.events || []);

          let totalAlerts = 0;
          let totalHigh = 0;
          let totalCriminal = 0;
          (data.events || []).forEach(evt => {
            if (evt.alert_triggered) totalAlerts++;
            if (evt.threat_level === 'HIGH' || evt.threat_level === 'CRITICAL') totalHigh++;
            if (evt.criminal_name) totalCriminal++;
          });
          onStats({
            frames: (data.events || []).length,
            alerts: totalAlerts,
            high: totalHigh,
            criminal: totalCriminal,
          });

          showToast(`✅ Video analysis complete! ${data.events.length} key events identified.`, 'green', 5000);
          return;
        }
        if (data.type === 'batch_error') {
          setBatchProgress(null);
          showToast(`❌ Video analysis error: ${data.message}`, 'red', 5000);
          return;
        }

        if (data.frame_b64) {
          setFrame(`data:image/jpeg;base64,${data.frame_b64}`);
          setLastSeen(new Date());
          tick();
        }
        setEvent(data);
        onStats(prev => ({
          frames:   (prev.frames   || 0) + 1,
          alerts:   (prev.alerts   || 0) + (data.alert_triggered   ? 1 : 0),
          high:     (prev.high     || 0) + (data.threat_level === 'HIGH' || data.threat_level === 'CRITICAL' ? 1 : 0),
          criminal: (prev.criminal || 0) + (data.criminal_name     ? 1 : 0),
        }));
      },
      // onStatus
      updateStatus,
    );

    return () => {
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [running]);

  const threat      = event?.threat_level || 'LOW';
  const threatColor = THREAT_COLOR[threat] || '#94A3B8';
  const dets        = event?.detections || [];
  const obs         = event?.key_observations || [];

  // Overlay text for feed placeholder
  const feedOverlay = () => {
    if (!running) return { icon: '🛰️', title: 'TACTICAL FEED OFFLINE', sub: 'Select a camera and click ENGAGE' };
    if (wsStatus === 'connecting')   return { icon: '📡', title: 'ESTABLISHING NEURAL LINK…', sub: 'Connecting to surveillance stream' };
    if (wsStatus === 'reconnecting') return { icon: '🔄', title: 'RECONNECTING…', sub: 'Backend connection lost — retrying' };
    if (wsStatus === 'error')        return { icon: '⚠️', title: 'CONNECTION ERROR', sub: 'Check server is running on port 8000' };
    return { icon: '🛰️', title: 'STREAM ACTIVE — AWAITING FIRST FRAME…', sub: 'Calibrating YOLOv8 + Gemini VLM buffers' };
  };
  const overlay = feedOverlay();

  return (
    <div>
      {/* ── HUD Stat Row ── */}
      <div className="stat-row">
        {[
          { label: 'Neural Frames',       val: stats.frames   || 0, cls: 'blue'   },
          { label: 'Security Alerts',     val: stats.alerts   || 0, cls: 'orange' },
          { label: 'Active Threats',      val: stats.high     || 0, cls: 'red'    },
          { label: 'Biometric Sightings', val: stats.criminal || 0, cls: 'amber'  },
        ].map(s => (
          <div className="stat-box" key={s.label}>
            <div className={`stat-num ${s.cls}`}>{s.val.toLocaleString()}</div>
            <div className="stat-lbl">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="monitor-grid">
        {/* ── Left: Live Feed ── */}
        <div>
          {batchProgress && (
            <div className="feed-box" style={{ background: '#0a0f1e', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: 320, border: '1px solid rgba(6,182,212,0.15)', boxShadow: '0 0 20px rgba(6,182,212,0.05)' }}>
              <span className="spinner-dot" style={{ width: 32, height: 32, border: '3px solid #06B6D4', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite' }} />
              <span style={{ fontSize: '1.05rem', color: '#06B6D4', fontWeight: 700, marginTop: 16, letterSpacing: '0.08em', fontFamily: 'var(--font-mono)' }}>
                NEURAL SCANNING IN PROGRESS
              </span>
              <span style={{ color: '#94A3B8', marginTop: 6, fontSize: '0.8rem', fontFamily: 'var(--font-mono)' }}>
                {batchProgress.phase}
              </span>
              <div style={{ width: '80%', background: 'rgba(255,255,255,0.08)', height: 6, borderRadius: 3, marginTop: 18, overflow: 'hidden' }}>
                <div style={{ width: `${batchProgress.percent}%`, background: 'linear-gradient(90deg, #06B6D4, #10B981)', height: '100%', transition: 'width 0.4s ease' }} />
              </div>
              <span style={{ fontSize: '0.78rem', color: '#64748B', marginTop: 8, fontFamily: 'var(--font-mono)' }}>
                {batchProgress.percent}% Complete
              </span>
            </div>
          )}

          {!batchProgress && (
            <>
              {/* Main Frame View (either live stream or selected batch keyframe) */}
              <div className="feed-box">
                {frame ? (
                  <img src={frame} alt="Surveillance frame" style={{ width: '100%', display: 'block' }} />
                ) : (
                  <div className="feed-placeholder">
                    <span style={{ fontSize: '3rem', filter: `drop-shadow(0 0 14px ${wsStatus === 'error' ? '#EF444488' : 'rgba(6,182,212,0.6)'})`, animation: running && wsStatus !== 'open' ? 'neon-pulse 1.5s infinite alternate' : 'none' }}>
                      {overlay.icon}
                    </span>
                    <span style={{ color: '#E2E8F0', fontWeight: 700, letterSpacing: '0.05em', textAlign: 'center' }}>
                      {overlay.title}
                    </span>
                    <span style={{ fontSize: '0.8rem', color: '#64748B', textAlign: 'center' }}>
                      {overlay.sub}
                    </span>
                    {running && wsStatus === 'reconnecting' && (
                      <div className="reconnect-bar">
                        <div className="reconnect-fill" />
                      </div>
                    )}
                  </div>
                )}

                {/* HUD Overlay for active feed */}
                {wsStatus === 'open' && !batchComplete && frame && (
                  <div className="feed-hud-overlay">
                    <span className="feed-hud-pill">⚡ {fps} fps</span>
                    {lastSeen && (
                      <span className="feed-hud-pill">
                        🕐 {lastSeen.toLocaleTimeString()}
                      </span>
                    )}
                  </div>
                )}
                {batchComplete && event && (
                  <div className="feed-hud-overlay">
                    <span className="feed-hud-pill" style={{ color: '#06B6D4', borderColor: '#06B6D4' }}>
                      KEYFRAME {event.frame_id}
                    </span>
                  </div>
                )}
              </div>

              {/* Camera metadata pills */}
              {event && (
                <div className="cam-pills">
                  <span className="cam-pill">📡 {event.camera_id}</span>
                  <span className="cam-pill">📍 {event.location}</span>
                  <span className="cam-pill">⏱️ {event.timestamp?.slice(11, 19)}</span>
                  <span className="cam-pill" style={{ color: threatColor, borderColor: threatColor, boxShadow: `0 0 10px ${threatColor}33` }}>
                    🎯 {threat}
                  </span>
                  {event.criminal_name && (
                    <span className="cam-pill cam-pill-alert">
                      🚨 {event.criminal_name.toUpperCase()}
                    </span>
                  )}
                </div>
              )}

              {/* Alert cards for selected event */}
              {event?.alert_triggered && (event.alerts || []).map((a, i) => (
                <div key={i} className={`alert-card ${a.severity} slide-in`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className={`badge ${a.severity}`}>{a.severity}</span>
                    <span style={{ fontSize: '0.73rem', color: '#94A3B8', fontFamily: 'var(--font-mono)' }}>{a.rule_name}</span>
                  </div>
                  <div style={{ marginTop: 8, fontSize: '0.88rem', color: '#fff', fontWeight: 500, lineHeight: 1.5 }}>
                    {a.alert_text}
                  </div>
                </div>
              ))}

              {/* Grid Gallery for all extracted event keyframes */}
              {batchComplete && (
                <div style={{ marginTop: 24 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: 6 }}>
                    <h3 style={{ margin: 0, color: '#06B6D4', fontSize: '0.88rem', fontWeight: 700, letterSpacing: '0.06em', fontFamily: 'var(--font-mono)' }}>
                      📂 EXTRACTED KEYFRAMES ({batchEvents.length})
                    </h3>
                    <span style={{ fontSize: '0.68rem', color: '#64748B', fontFamily: 'var(--font-mono)' }}>
                      SELECT IMAGE TO INSPECT
                    </span>
                  </div>
                  {batchEvents.length === 0 ? (
                    <div style={{ padding: '16px 8px', color: '#64748B', fontSize: '0.78rem', fontStyle: 'italic', background: 'rgba(255,255,255,0.01)', border: '1px dashed rgba(255,255,255,0.05)', borderRadius: 6, textAlign: 'center' }}>
                      No significant event frames found.
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 10 }}>
                      {batchEvents.map((evt, idx) => {
                        const isSelected = event && event.frame_id === evt.frame_id;
                        const tColor = THREAT_COLOR[evt.threat_level || 'LOW'] || '#94A3B8';
                        return (
                          <div
                            key={idx}
                            style={{
                              background: 'rgba(255,255,255,0.02)',
                              border: isSelected ? '1px solid #06B6D4' : '1px solid rgba(255,255,255,0.06)',
                              boxShadow: isSelected ? '0 0 10px rgba(6,182,212,0.15)' : 'none',
                              borderRadius: 6,
                              overflow: 'hidden',
                              cursor: 'pointer',
                              transition: 'all 0.2s ease',
                              opacity: isSelected ? 1.0 : 0.75,
                            }}
                            onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.opacity = 1.0; }}
                            onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.opacity = 0.75; }}
                            onClick={() => {
                              setEvent(evt);
                              if (evt.frame_b64) {
                                setFrame(`data:image/jpeg;base64,${evt.frame_b64}`);
                              }
                            }}
                          >
                            <div style={{ position: 'relative', aspectRatio: '1.77', background: '#0a0f1e' }}>
                              {evt.frame_b64 && (
                                <img
                                  src={`data:image/jpeg;base64,${evt.frame_b64}`}
                                  alt="Frame Thumbnail"
                                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                                />
                              )}
                              <span style={{
                                position: 'absolute', bottom: 4, left: 4,
                                padding: '1px 4px', borderRadius: 2, fontSize: '0.58rem', fontWeight: 700,
                                background: 'rgba(0,0,0,0.6)', color: '#fff', fontFamily: 'var(--font-mono)'
                              }}>
                                #{evt.frame_id}
                              </span>
                              <span style={{
                                position: 'absolute', top: 4, right: 4,
                                width: 6, height: 6, borderRadius: '50%',
                                background: tColor, boxShadow: `0 0 6px ${tColor}`
                              }} title={`Threat: ${evt.threat_level}`} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Right: VLM + Detections ── */}
        <div>
          <div className="section-title">🧠 Gemini Neural Intelligence</div>
          <div className="vlm-card">
            <div className="vlm-header">
              <span className="vlm-status">&gt; VLM_TOP_N_SCAN [ACTIVE]</span>
              <span className={`threat ${threat}`}>{threat}</span>
            </div>
            <div className="vlm-desc">
              {event?.vlm_description || 'Synthesizing ground-level contextual situational intelligence…'}
            </div>
            {obs.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                {obs.map((o, i) => (
                  <span key={i} className="vlm-tag">
                    #{o.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="section-title" style={{ marginTop: 20 }}>🎯 YOLOv8 Telemetry</div>
          <div className="det-card">
            <div className="det-row">
              <span className="det-label">Detected Targets</span>
              <span className="det-val">{dets.length} ACTIVE</span>
            </div>
            {dets.slice(0, 6).map((d, i) => (
              <div className="det-row" key={i}>
                <span style={{ color: '#E2E8F0', textTransform: 'capitalize' }}>▫ {d.label}</span>
                <span className="det-val">{(d.confidence * 100).toFixed(0)}%</span>
              </div>
            ))}
            {dets.length === 0 && !event && (
              <div style={{ color: '#475569', fontSize: '0.82rem', padding: '8px 0', textAlign: 'center' }}>
                Awaiting detections…
              </div>
            )}
            <div className="det-row" style={{ marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 10 }}>
              <span className="det-label">Biometric Hit</span>
              <span className="det-val" style={{
                color:      event?.criminal_name ? '#EF4444' : '#475569',
                textShadow: event?.criminal_name ? '0 0 10px #EF4444' : 'none',
                fontWeight: event?.criminal_name ? 800 : 400,
              }}>
                {event?.criminal_name ? event.criminal_name.toUpperCase() : 'CLEAR'}
              </span>
            </div>
            <div className="det-row">
              <span className="det-label">Risk Index</span>
              <span className={`threat ${event?.risk_level || 'LOW'}`}>
                {event?.risk_level || 'LOW'} ({event?.risk_score || 0}/100)
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
