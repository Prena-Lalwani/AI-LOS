/** PageHeader — module title + subtitle and a right-aligned primary action. */
export default function PageHeader({ title, subtitle, action = null }) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action && (
        <button className="btn btn--primary">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 3h8l3 3v15H7zM14 3v4h4M9 13h6M9 17h4" />
          </svg>
          {action}
        </button>
      )}
    </div>
  );
}
