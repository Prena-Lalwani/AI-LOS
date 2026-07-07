import { useEffect, useState } from 'react';
import StatusRibbon from './StatusRibbon.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import { USER, INITIALS } from '../user.js';

function fmtClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Persistent top bar: the live StatusRibbon plus a running clock, the theme
 * toggle and the user avatar — shown on every module.
 */
export default function TopBar({ onMenu }) {
  const [clock, setClock] = useState(fmtClock());
  useEffect(() => {
    const t = setInterval(() => setClock(fmtClock()), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <header className="topbar">
      <button className="topbar__menu" onClick={onMenu} aria-label="Open navigation menu">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
      <StatusRibbon />
      <div className="topbar__spacer" />
      <span className="clock">{clock}</span>
      <ThemeToggle />
      <div className="avatar" title={USER.name}>{INITIALS}</div>
    </header>
  );
}
