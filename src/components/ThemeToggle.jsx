import { useTheme } from '../theme/ThemeContext.jsx';

/** Light/dark switch. Lives in the top bar; flips <html data-theme>. */
export default function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const light = theme === 'light';

  return (
    <button className="theme-toggle" onClick={toggle} title="Toggle theme" aria-label="Toggle color theme">
      <span className={`theme-toggle__opt${light ? ' active' : ''}`}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
        </svg>
      </span>
      <span className={`theme-toggle__opt${!light ? ' active' : ''}`}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M20 14a8 8 0 11-9-11 6 6 0 009 11z" />
        </svg>
      </span>
    </button>
  );
}
