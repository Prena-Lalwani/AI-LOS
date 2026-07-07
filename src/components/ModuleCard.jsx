import { useNavigate } from 'react-router-dom';

/**
 * ModuleCard — card that links into a module or feature. Renders an icon,
 * title and short description; navigates to `to` on click.
 */
export default function ModuleCard({ icon, title, desc, to }) {
  const navigate = useNavigate();
  return (
    <button className="module-card" onClick={() => to && navigate(to)}>
      <span className="module-card__icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round">
          <path d={icon} />
        </svg>
      </span>
      <span className="module-card__body">
        <span className="module-card__title">{title}</span>
        <span className="module-card__desc">{desc}</span>
      </span>
    </button>
  );
}
