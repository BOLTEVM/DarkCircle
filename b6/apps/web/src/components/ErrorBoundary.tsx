import React from 'react';

interface State {
  error: Error | null;
}

/** A page that throws shows what happened instead of taking the whole site down. */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-2xl px-4 py-20">
        <h1 className="font-display text-3xl text-bone">This page hit an error</h1>
        <p className="mt-3 text-sm text-bone-dim">Nothing was sent from your wallet. Reload to try again.</p>
        <pre className="mt-6 overflow-x-auto rounded-lg border border-line bg-ink-deep p-4 font-mono text-xs text-rose-200">{this.state.error.message}</pre>
      </div>
    );
  }
}
