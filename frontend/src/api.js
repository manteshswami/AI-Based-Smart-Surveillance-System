// WatchAI API helpers — fetch + auto-reconnecting WebSocket
const BASE    = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const WS_BASE = BASE.replace(/^http/, 'ws');

// ── Fetch wrapper with error handling ─────────────────────────────────────────
async function apiFetch(url, opts = {}) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`[API] ${opts.method || 'GET'} ${url} failed:`, err.message);
    throw err;
  }
}

export const api = {
  health:    ()                    => apiFetch(`${BASE}/health`),
  cameras:   ()                    => apiFetch(`${BASE}/cameras`),
  events:    (limit = 50)          => apiFetch(`${BASE}/events?limit=${limit}`),
  alerts:    (severity='',limit=20)=> apiFetch(`${BASE}/alerts?severity=${severity}&limit=${limit}`),
  criminals: ()                    => apiFetch(`${BASE}/criminals`),
  summary:   ()                    => apiFetch(`${BASE}/summary`),
  control:   (body)                => apiFetch(`${BASE}/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  chat: (message, thread_id = 'default') => apiFetch(`${BASE}/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, thread_id }),
  }),
  uploadVideo: (file) => {
    const form = new FormData();
    form.append('file', file);
    return apiFetch(`${BASE}/upload_video`, { method: 'POST', body: form });
  },
  analyzeVideo: (body) => apiFetch(`${BASE}/analyze_video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }),
  enrollCriminal: (name, files) => {
    const form = new FormData();
    form.append('name', name);
    files.forEach(f => form.append('files', f));
    return apiFetch(`${BASE}/enroll_criminal`, { method: 'POST', body: form });
  },
  listEnrolled: () => apiFetch(`${BASE}/enrolled_criminals`),
  checkFace: (file) => {
    const form = new FormData();
    form.append('file', file);
    return apiFetch(`${BASE}/check_face`, { method: 'POST', body: form });
  },
};

// ── Auto-reconnecting WebSocket ────────────────────────────────────────────────
// onMessage(data)  — called for every non-heartbeat JSON event
// onStatus(status) — called with: 'connecting' | 'open' | 'closed' | 'error'
//
// Returns a controller object: { close() }
export function createReconnectingSocket(onMessage, onStatus) {
  let ws       = null;
  let stopped  = false;
  let attempt  = 0;
  let pingTimer = null;

  const BASE_DELAY = 1000;  // 1s initial retry
  const MAX_DELAY  = 10000; // 10s max retry

  function connect() {
    if (stopped) return;

    onStatus('connecting');
    attempt++;
    ws = new WebSocket(`${WS_BASE}/ws/feed`);

    ws.onopen = () => {
      attempt = 0;
      onStatus('open');
      // Clear any lingering ping timers
      clearTimeout(pingTimer);
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (!data.heartbeat) onMessage(data);
      } catch {/* ignore parse errors */}
    };

    ws.onerror = () => {
      onStatus('error');
    };

    ws.onclose = () => {
      if (stopped) { onStatus('closed'); return; }
      const delay = Math.min(BASE_DELAY * Math.pow(1.5, attempt - 1), MAX_DELAY);
      onStatus('reconnecting');
      pingTimer = setTimeout(connect, delay);
    };
  }

  connect();

  return {
    close() {
      stopped = true;
      clearTimeout(pingTimer);
      ws?.close();
    },
  };
}
