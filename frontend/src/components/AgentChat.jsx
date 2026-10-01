import { useState, useRef, useEffect } from 'react';
import { api } from '../api';

const SUGGESTIONS = [
  'Summarize today\'s security activity',
  'Show all CRITICAL threat alerts',
  'List criminal sightings from the database',
  'What happened at the parking lot?',
];

export default function AgentChat({ showToast }) {
  const [history, setHistory] = useState([]);
  const [input,   setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history, loading]);

  const send = async (msg) => {
    msg = (msg || input).trim();
    if (!msg || loading) return;
    setInput('');
    setHistory(h => [...h, { role: 'user', content: msg }]);
    setLoading(true);
    try {
      const res = await api.chat(msg);
      setHistory(h => [...h, { role: 'agent', content: res.response || 'No response generated.' }]);
    } catch {
      setHistory(h => [...h, {
        role: 'agent',
        content: '⚠️ Agent unreachable. Verify Ollama is running and the llama3.2:1b model is pulled.',
        error: true,
      }]);
      showToast('❌ Agent connection failed', 'red', 4000);
    }
    setLoading(false);
  };

  const onKey = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };

  const clearHistory = () => {
    setHistory([]);
    showToast('🔄 Chat history cleared', 'cyan', 2000);
  };

  return (
    <div className="chat-wrap">
      <div className="chat-messages">
        {history.length === 0 && (
          <div style={{ padding: '20px 10px', textAlign: 'center' }}>
            <span style={{ fontSize: '3.5rem', display: 'block', marginBottom: 14, filter: 'drop-shadow(0 0 16px rgba(6,182,212,0.8))' }}>
              🤖
            </span>
            <div style={{ color: '#F1F5F9', fontWeight: 800, fontSize: '1.15rem', letterSpacing: '0.02em', marginBottom: 6 }}>
              WatchAI Security Assistant
            </div>
            <div style={{ color: '#64748B', fontSize: '0.85rem', marginBottom: 24, maxWidth: 420, margin: '0 auto 24px', lineHeight: 1.65 }}>
              Powered by LangGraph + local Ollama. Ask anything about your surveillance logs, criminal sightings, or threat history.
            </div>
            <div style={{ fontSize: '0.75rem', color: '#475569', marginBottom: 18 }}>Press Enter to send · Shift+Enter for new line</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', maxWidth: 560, margin: '0 auto' }}>
              {SUGGESTIONS.map(s => (
                <button
                  key={s}
                  className="btn"
                  style={{ width: 'auto', padding: '8px 14px', fontSize: '0.8rem', background: 'rgba(30,41,59,0.5)', borderColor: 'rgba(6,182,212,0.25)' }}
                  onClick={() => send(s)}
                >
                  &gt; {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {history.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column' }}>
            <div className={`chat-bubble ${m.role}`} style={m.error ? { borderColor: 'rgba(239,68,68,0.4)' } : {}}>
              {m.role === 'agent' && (
                <span style={{ fontSize: '0.7rem', color: m.error ? '#EF4444' : '#38BDF8', fontWeight: 800, letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
                  {m.error ? '⚠️ AGENT ERROR' : '🤖 WATCHAI AGENT'}
                </span>
              )}
              {m.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="chat-bubble agent" style={{ borderStyle: 'dashed' }}>
            <span style={{ fontSize: '0.7rem', color: '#38BDF8', fontWeight: 800, letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}>
              🤖 WATCHAI AGENT
            </span>
            <div className="loading-dots" style={{ justifyContent: 'flex-start' }}>
              <span /><span /><span />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-row">
        {history.length > 0 && (
          <button className="btn" style={{ width: 'auto', padding: '12px 14px', flexShrink: 0 }} onClick={clearHistory} title="Clear chat">
            🗑
          </button>
        )}
        <input
          className="chat-input"
          placeholder="Ask about events, criminals, threats, or request a summary…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKey}
          disabled={loading}
        />
        <button className="chat-send" onClick={() => send()} disabled={loading || !input.trim()}>
          {loading ? '…' : 'SEND'}
        </button>
      </div>
    </div>
  );
}
