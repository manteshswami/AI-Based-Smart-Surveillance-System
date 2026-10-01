import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

const THREAT_COLOR = {
  HIGH:     '#F97316',
  MEDIUM:   '#F59E0B',
  LOW:      '#10B981',
  CRITICAL: '#EF4444',
};

const WS_STATUS_META = {
  open:         { label: 'LIVE',         color: '#10B981', pulse: true  },
  connecting:   { label: 'CONNECTING',   color: '#F59E0B', pulse: true  },
  reconnecting: { label: 'RECONNECTING', color: '#F97316', pulse: true  },
  closed:       { label: 'OFFLINE',      color: '#64748B', pulse: false },
  error:        { label: 'ERROR',        color: '#EF4444', pulse: false },
};

export default function Sidebar({ running, wsStatus, onStart, onStop, onReset, stats, showToast }) {
  const [health,    setHealth]    = useState(null);
  const [activeCam, setActiveCam] = useState('cam2');   // 'cam1' | 'cam2'

  // ── Camera 2 state ──────────────────────────────────────────────────────────
  const [selected,  setSelected]  = useState(null);
  const [uploading, setUploading] = useState(false);

  // ── Camera 1 state ──────────────────────────────────────────────────────────
  const [faceFile,    setFaceFile]    = useState(null);       // File object
  const [facePreview, setFacePreview] = useState(null);       // base64 preview URL
  const [checking,    setChecking]    = useState(false);
  const [faceResult,  setFaceResult]  = useState(null);       // API response
  const faceInputRef = useRef(null);

  // Backend health poll
  useEffect(() => {
    const check = () => api.health()
      .then(r => setHealth(r.status === 'ok'))
      .catch(() => setHealth(false));
    check();
    const t = setInterval(check, 8000);
    return () => clearInterval(t);
  }, []);

  // ── Camera 2 handlers ───────────────────────────────────────────────────────
  const handleVideoUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    showToast(`📤 Uploading ${file.name}…`, 'cyan', 3000);
    api.uploadVideo(file)
      .then(res => {
        showToast('✅ Video uploaded! Click ENGAGE to analyse.', 'green', 3000);
        setSelected({
          source:    res.source,
          location:  `File: ${res.filename}`,
          camera_id: 'CAM-2-SCENE',
          role:      'both',
        });
      })
      .catch(err => showToast(`❌ Upload failed: ${err.message}`, 'red', 5000))
      .finally(() => setUploading(false));
  };

  const handleStart = () => {
    if (!selected) return;
    onStart({
      source:      selected.source,
      camera_role: selected.role,
      location:    selected.location,
      camera_id:   selected.camera_id,
    });
  };

  // ── Camera 1 handlers ───────────────────────────────────────────────────────
  const handleFaceSelect = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFaceFile(file);
    setFaceResult(null);
    const reader = new FileReader();
    reader.onload = ev => setFacePreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const handleFaceDrop = (e) => {
    e.preventDefault();
    const file = Array.from(e.dataTransfer?.files || []).find(f => f.type.startsWith('image/'));
    if (!file) return;
    setFaceFile(file);
    setFaceResult(null);
    const reader = new FileReader();
    reader.onload = ev => setFacePreview(ev.target.result);
    reader.readAsDataURL(file);
  };

  const handleFaceAnalyse = () => {
    if (!faceFile) { showToast('⚠️ Upload a photo first.', 'red', 3000); return; }
    setChecking(true);
    setFaceResult(null);
    api.checkFace(faceFile)
      .then(res => { setFaceResult(res); })
      .catch(err => showToast(`❌ Analysis failed: ${err.message}`, 'red', 5000))
      .finally(() => setChecking(false));
  };

  const wsMeta = WS_STATUS_META[wsStatus] || WS_STATUS_META.closed;

  return (
    <aside className="sidebar">

      {/* ── Brand ── */}
      <div className="sidebar-brand">
        <span style={{ fontSize: '1.6rem' }}>🛡️</span>
        <span>WatchAI</span>
        <span
          title={health === null ? 'Checking server…' : health ? 'Server online' : 'Server offline'}
          style={{
            marginLeft: 'auto', width: 8, height: 8, borderRadius: '50%',
            background: health === null ? '#64748B' : health ? '#10B981' : '#EF4444',
            boxShadow: health ? '0 0 8px #10B981' : 'none', flexShrink: 0,
          }}
        />
      </div>
      <div style={{ fontSize: '0.7rem', color: '#64748B', padding: '0 18px 14px', fontWeight: 600, letterSpacing: '0.05em' }}>
        NEURAL SURVEILLANCE MATRIX
      </div>
      <hr />

      {/* ── WS Status (only for CAM-2 while running) ── */}
      {running && activeCam === 'cam2' && (
        <div className="sidebar-section" style={{ marginBottom: 10 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            background: `${wsMeta.color}15`, border: `1px solid ${wsMeta.color}55`,
            borderRadius: 8, padding: '7px 12px',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: wsMeta.color, boxShadow: `0 0 8px ${wsMeta.color}`,
              animation: wsMeta.pulse ? 'neon-pulse 1.2s infinite alternate' : 'none', flexShrink: 0,
            }} />
            <span style={{ fontSize: '0.72rem', fontFamily: 'var(--font-mono)', color: wsMeta.color, fontWeight: 700, letterSpacing: '0.06em' }}>
              STREAM {wsMeta.label}
            </span>
          </div>
        </div>
      )}

      {/* ── Camera Tab Switcher ── */}
      <div className="sidebar-section">
        <div className="sidebar-label">📡 Active Feeds</div>
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          {[
            { id: 'cam1', label: '👤 Camera 1', sub: 'Face Check',  color: '#A78BFA' },
            { id: 'cam2', label: '🎬 Camera 2', sub: 'Scene Video', color: '#06B6D4' },
          ].map(cam => {
            const active = activeCam === cam.id;
            return (
              <button
                key={cam.id}
                onClick={() => { setActiveCam(cam.id); setFaceResult(null); }}
                disabled={running || uploading || checking}
                style={{
                  flex: 1, padding: '8px 4px', borderRadius: 6,
                  border: `1px solid ${active ? cam.color : 'rgba(255,255,255,0.1)'}`,
                  background: active ? `${cam.color}18` : 'rgba(255,255,255,0.03)',
                  color: active ? cam.color : '#64748B', fontWeight: 700,
                  fontSize: '0.7rem', cursor: 'pointer', fontFamily: 'var(--font-mono)',
                  transition: 'all 0.2s', boxShadow: active ? `0 0 10px ${cam.color}22` : 'none',
                  letterSpacing: '0.04em',
                }}
              >
                <div>{cam.label}</div>
                <div style={{ fontSize: '0.58rem', fontWeight: 400, marginTop: 2, opacity: 0.7 }}>{cam.sub}</div>
              </button>
            );
          })}
        </div>
      </div>

      <hr />

      {/* ══════════════════════════════════════════════════════════════
          CAMERA 1 — Face Check
      ══════════════════════════════════════════════════════════════ */}
      {activeCam === 'cam1' && (
        <div className="sidebar-section">
          <div className="sidebar-label" style={{ color: '#A78BFA' }}>👤 CAM-1 · Face Analysis</div>

          {/* Drop zone / preview */}
          <div
            onDrop={handleFaceDrop}
            onDragOver={e => e.preventDefault()}
            onClick={() => faceInputRef.current?.click()}
            style={{
              marginTop: 10, borderRadius: 8, overflow: 'hidden',
              border: `1px dashed ${facePreview ? '#A78BFA' : 'rgba(167,139,250,0.3)'}`,
              background: 'rgba(167,139,250,0.04)', cursor: 'pointer',
              minHeight: 110, display: 'flex', alignItems: 'center',
              justifyContent: 'center', flexDirection: 'column', gap: 6,
              transition: 'all 0.2s',
            }}
          >
            {facePreview ? (
              <img src={facePreview} alt="face preview" style={{
                width: '100%', maxHeight: 160, objectFit: 'cover', display: 'block',
              }} />
            ) : (
              <>
                <span style={{ fontSize: '1.8rem', filter: 'drop-shadow(0 0 8px #A78BFA88)' }}>👤</span>
                <span style={{ fontSize: '0.72rem', color: '#64748B', textAlign: 'center' }}>
                  Drop photo or click to upload
                </span>
              </>
            )}
            <input ref={faceInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFaceSelect} />
          </div>

          {facePreview && (
            <button
              style={{ marginTop: 4, fontSize: '0.65rem', color: '#475569', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 0' }}
              onClick={() => { setFaceFile(null); setFacePreview(null); setFaceResult(null); if (faceInputRef.current) faceInputRef.current.value = ''; }}
            >
              × Clear image
            </button>
          )}

          {/* Analyse button */}
          <button
            onClick={handleFaceAnalyse}
            disabled={checking || !faceFile}
            style={{
              marginTop: 10, width: '100%', padding: '9px 0',
              background: checking ? 'rgba(167,139,250,0.1)' : faceFile ? 'rgba(167,139,250,0.25)' : 'rgba(255,255,255,0.04)',
              border: `1px solid ${faceFile ? 'rgba(167,139,250,0.5)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 6, color: faceFile ? '#A78BFA' : '#475569',
              fontWeight: 700, fontSize: '0.78rem', letterSpacing: '0.07em',
              cursor: faceFile && !checking ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-mono)', transition: 'all 0.2s',
            }}
          >
            {checking ? '⏳ ANALYSING…' : '🔍 ANALYSE FACE'}
          </button>

          {/* Result card */}
          {faceResult && (
            <div style={{
              marginTop: 12, borderRadius: 8, overflow: 'hidden',
              border: `1px solid ${faceResult.matched ? (THREAT_COLOR[faceResult.risk_level] || '#F97316') : 'rgba(16,185,129,0.3)'}`,
              background: faceResult.matched ? 'rgba(239,68,68,0.06)' : 'rgba(16,185,129,0.05)',
            }}>
              {/* Header */}
              <div style={{
                padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                background: faceResult.matched ? 'rgba(239,68,68,0.1)' : 'rgba(16,185,129,0.08)',
                borderBottom: '1px solid rgba(255,255,255,0.06)',
              }}>
                <span style={{ fontSize: '0.75rem', fontWeight: 800, color: faceResult.matched ? '#EF4444' : '#10B981', fontFamily: 'var(--font-mono)' }}>
                  {faceResult.matched ? '🚨 MATCH FOUND' : '✅ NO MATCH'}
                </span>
                {faceResult.matched && (
                  <span style={{
                    fontSize: '0.62rem', fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                    background: THREAT_COLOR[faceResult.risk_level] + '22',
                    color: THREAT_COLOR[faceResult.risk_level] || '#F97316',
                    border: `1px solid ${THREAT_COLOR[faceResult.risk_level] || '#F97316'}44`,
                  }}>
                    {faceResult.risk_level}
                  </span>
                )}
              </div>

              {/* Body */}
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {!faceResult.face_found && (
                  <span style={{ fontSize: '0.76rem', color: '#F59E0B' }}>⚠️ No face detected in image.</span>
                )}
                {faceResult.matched && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                      <span style={{ color: '#94A3B8' }}>Name</span>
                      <span style={{ color: '#E2E8F0', fontWeight: 700 }}>{faceResult.name?.replace(/_/g, ' ').toUpperCase()}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                      <span style={{ color: '#94A3B8' }}>Confidence</span>
                      <span style={{ color: '#A78BFA', fontWeight: 700 }}>{faceResult.confidence}%</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                      <span style={{ color: '#94A3B8' }}>Risk Score</span>
                      <span style={{ color: THREAT_COLOR[faceResult.risk_level] || '#F97316', fontWeight: 700 }}>{faceResult.risk_score}/100</span>
                    </div>
                    {faceResult.crime_type && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                        <span style={{ color: '#94A3B8' }}>Crime</span>
                        <span style={{ color: '#E2E8F0' }}>{faceResult.crime_type}</span>
                      </div>
                    )}
                    {faceResult.legal_status && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem' }}>
                        <span style={{ color: '#94A3B8' }}>Status</span>
                        <span style={{ color: '#E2E8F0' }}>{faceResult.legal_status}</span>
                      </div>
                    )}
                  </>
                )}
                {!faceResult.matched && faceResult.face_found && (
                  <span style={{ fontSize: '0.76rem', color: '#94A3B8' }}>Person not found in criminal database.</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════
          CAMERA 2 — Video Upload & Scene Analysis
      ══════════════════════════════════════════════════════════════ */}
      {activeCam === 'cam2' && (
        <>
          <div className="sidebar-section">
            <div className="sidebar-label" style={{ color: '#06B6D4' }}>🎬 CAM-2 · Scene Video</div>

            {!running && (
              <label
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginTop: 10,
                  background: 'rgba(6,182,212,0.06)', border: '1px dashed rgba(6,182,212,0.3)',
                  borderRadius: 6, padding: '10px', cursor: uploading ? 'not-allowed' : 'pointer',
                  fontSize: '0.75rem', color: '#06B6D4', justifyContent: 'center', transition: 'all 0.2s',
                }}
              >
                {uploading ? (
                  <>
                    <span className="spinner-dot" style={{ width: 6, height: 6, background: '#06B6D4' }} />
                    <span>Uploading video…</span>
                  </>
                ) : (
                  <>
                    <span>📤 Upload Scene Video</span>
                    <input type="file" accept="video/*" onChange={handleVideoUpload} style={{ display: 'none' }} disabled={uploading} />
                  </>
                )}
              </label>
            )}

            {selected && (
              <div style={{ fontSize: '0.68rem', color: '#10B981', marginTop: 8, fontFamily: 'var(--font-mono)', textAlign: 'center' }}>
                ✅ {selected.location?.slice(0, 32)}
              </div>
            )}
          </div>

          <hr />

          {/* Controls */}
          <div className="sidebar-section">
            <div className="sidebar-label">🕹️ Tactical Override</div>
          </div>
          <div className="btn-row">
            <button className="btn primary" onClick={handleStart} disabled={running || !selected || uploading}>
              {running ? '● STREAMING' : '▶ ENGAGE'}
            </button>
            <button className="btn" onClick={onStop} disabled={!running}>⏸ STANDBY</button>
          </div>
          <div style={{ padding: '0 14px 8px' }}>
            <button className="btn danger" onClick={onReset}>🔄 PURGE BUFFER</button>
          </div>
        </>
      )}

      <hr />

      {/* ── Telemetry ── */}
      <div className="sidebar-section">
        <div className="sidebar-label">📊 Core Telemetry</div>
      </div>
      {[
        { label: 'Frames Ingested', val: stats.frames   || 0 },
        { label: 'Threat Alerts',   val: stats.alerts   || 0 },
        { label: 'Biometric Hits',  val: stats.criminal || 0 },
      ].map(s => (
        <div className="stat-mini" key={s.label}>
          <span style={{ color: '#94A3B8' }}>{s.label}</span>
          <span className="val">{s.val.toLocaleString()}</span>
        </div>
      ))}

      <hr />

      {/* ── Zonal coverage ── */}
      <div style={{ padding: '12px 18px', fontSize: '0.7rem', color: '#475569', lineHeight: 1.7 }}>
        <div style={{ color: '#06B6D4', fontWeight: 700, marginBottom: 4, letterSpacing: '0.05em' }}>ZONAL COVERAGE</div>
        <div>🏦 Bank · 🛣️ Perimeter · 🛒 Retail</div>
        <div>🅿️ Parking · 🏧 ATM · 🏢 Office</div>
      </div>

    </aside>
  );
}
