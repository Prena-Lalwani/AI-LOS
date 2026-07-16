import { useEffect, useRef, useState } from 'react';
import PageHeader from '../../components/PageHeader.jsx';
import RoiCard from '../../components/RoiCard.jsx';
import { initialMessages, suggestedPrompts, aiReply } from '../../data/copilot.js';

// In-memory (cache) copy of the conversation — NOT a database. It keeps the
// chat alive while navigating between pages, but a full browser refresh clears
// the module and the chat resets to the starting messages.
let cachedChat = null;

export default function Copilot() {
  const [messages, setMessages] = useState(cachedChat || initialMessages);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const logRef = useRef(null);

  // mirror the conversation into the cache so it survives route navigation
  useEffect(() => { cachedChat = messages; }, [messages]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, typing]);

  const send = (text) => {
    if (typing) return;                                   // ignore while AI is "thinking"
    const q = (typeof text === 'string' ? text : input).trim();
    if (!q) return;
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setInput('');
    setTyping(true);
    const r = aiReply(q);
    // realistic pause — longer for longer answers (as if the AI is composing)
    const delay = 800 + (r.bullets?.length ? 700 : 0) + Math.min(900, r.text.length * 12);
    setTimeout(() => {
      setMessages((m) => [...m, { role: 'ai', text: r.text, bullets: r.bullets }]);
      setTyping(false);
    }, delay);
  };

  return (
    <>
      <PageHeader title="AI Operations Copilot" subtitle="Ask across all modules in natural language" />

      <RoiCard
        subtitle="Decision speed"
        items={[
          { value: 'Minutes → seconds', label: 'Time to an answer', note: 'ask in plain language instead of hunting across dashboards' },
          { value: 'All 5 modules', label: 'One place to ask', note: 'demand, inventory, dispatch, fleet & executive combined' },
          { value: 'Fewer handoffs', label: 'Self-serve insight', note: 'ops staff answer their own questions without an analyst' },
        ]}
        footnote="Productivity lever — value scales with how many people rely on the data day to day."
      />

      <div className="split split--copilot">
        <div className="card" style={{ padding: 0 }}>
          <div className="chat">
            <div className="chat__log" ref={logRef}>
              {messages.map((m, i) => (
                <div className={`chat__row ${m.role}`} key={i}>
                  {m.role === 'ai' && <div className="chat__avatar">AI</div>}
                  <div className={`bubble ${m.role}`}>
                    <div>{m.text}</div>
                    {m.bullets && m.bullets.length > 0 && (
                      <ul>
                        {m.bullets.map((b, bi) => (
                          <li key={bi}>{b}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
              {typing && (
                <div className="chat__row ai">
                  <div className="chat__avatar">AI</div>
                  <div className="bubble ai" aria-label="Copilot is typing">
                    <span className="typing-dots"><span /><span /><span /></span>
                  </div>
                </div>
              )}
            </div>
            <div className="chat__input-row">
              <input
                className="chat__input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
                placeholder={typing ? 'Copilot is thinking…' : 'Ask about operations, routes, inventory, or fleet…'}
                disabled={typing}
              />
              <button className="chat__send" onClick={() => send()} aria-label="Send" disabled={typing}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12l16-8-6 16-2.5-6.5z" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        <div className="col">
          <div className="card">
            <h2 style={{ marginBottom: 12 }}>Suggested Prompts</h2>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {suggestedPrompts.map((p) => (
                <button key={p} className="prompt-chip" onClick={() => send(p)}>{p}</button>
              ))}
            </div>
          </div>
          <div className="card">
            <h2 style={{ marginBottom: 10 }}>Capabilities</h2>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {['Root cause analysis', 'Business recommendations', 'Report generation', 'Workflow automation'].map((c) => (
                <span key={c} className="pill s-flow">{c}</span>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.55, marginTop: 10 }}>
              Grounded in live data across all 7 modules.
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
