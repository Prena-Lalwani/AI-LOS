import { Component } from 'react';

/**
 * Catches render/async-import failures in a subtree so one broken chunk (e.g. a
 * stale dev-cache 504 on a lazy route) shows a small message instead of blanking
 * the entire app. Key it by route path so it resets when the user navigates.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err) {
    // surfaced in the console for debugging; the UI stays usable
    console.error('A view failed to load:', err);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="card" style={{ maxWidth: 560 }}>
          <h2 style={{ marginBottom: 8 }}>This view didn&rsquo;t load</h2>
          <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
            Part of the app failed to load — usually a stale cache. Refresh the page
            (Ctrl + Shift + R). If it keeps happening, restart the dev server.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
