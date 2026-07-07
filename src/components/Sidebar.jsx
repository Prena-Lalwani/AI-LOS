import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { MODULES } from '../modules.js';
import { USER, INITIALS } from '../user.js';

export default function Sidebar({ mobileOpen = false, onNavigate }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}${mobileOpen ? ' open' : ''}`}>
      <div className="sidebar__brand">
        <div className="sidebar__logo">AL</div>
        <span className="sidebar__name">AI&#8209;LOS</span>
      </div>

      <nav className="sidebar__nav">
        {MODULES.map((m) => (
          <NavLink
            key={m.path}
            to={m.path}
            end={m.path === '/'}
            onClick={onNavigate}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
              <path d={m.icon} />
            </svg>
            <span>{m.label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="sidebar__user" title={USER.email}>
        <div className="sidebar__avatar">{INITIALS}</div>
        <span className="sidebar__user-name">{USER.name}</span>
      </div>

      <button className="sidebar__collapse" onClick={() => setCollapsed((c) => !c)} aria-label="Collapse sidebar" title="Collapse">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 6l-6 6 6 6" />
        </svg>
      </button>
    </aside>
  );
}
