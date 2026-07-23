import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Icon } from './Icon';

export class DashboardErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`Dashboard render failed: ${error.message}`, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="startup-screen" id="main-content">
        <div className="startup-card startup-card--error" role="alert">
          <span className="entity-glyph entity-glyph--error"><Icon name="warning" /></span>
          <p className="eyebrow">Dashboard interrupted</p>
          <h1>This view couldn’t finish rendering.</h1>
          <p>Your data is still safe in PostgreSQL. Reload the local dashboard to try again.</p>
          <button className="button button--primary" onClick={() => window.location.reload()} type="button">
            <Icon name="refresh" size={16} /> Reload dashboard
          </button>
        </div>
      </main>
    );
  }
}
