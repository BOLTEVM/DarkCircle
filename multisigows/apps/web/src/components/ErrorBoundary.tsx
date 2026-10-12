import React from 'react';

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Top-level render error boundary. Without this, an uncaught exception anywhere in
 * the tree (e.g. a malformed RPC response propagating into a render) produces a blank
 * white screen with no recovery path for the user.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('DarkSafe dashboard crashed:', error, info.componentStack);
  }

  private handleReload = (): void => {
    this.setState({ error: null });
    window.location.reload();
  };

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-slate-950 p-6">
          <div className="max-w-md w-full bg-slate-900 border border-red-800/50 rounded-2xl p-6 text-center">
            <h1 className="text-lg font-bold text-white mb-2">Something went wrong</h1>
            <p className="text-sm text-slate-400 mb-4">
              The dashboard hit an unexpected error and stopped rendering. This does not affect any
              on-chain state or funds.
            </p>
            <pre className="text-left text-[11px] text-red-300 bg-slate-950 border border-slate-800 rounded-lg p-3 mb-4 overflow-x-auto">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              onClick={this.handleReload}
              className="w-full py-2 px-4 bg-emerald-500 hover:bg-emerald-400 text-slate-950 rounded-xl text-sm font-bold transition-colors"
            >
              Reload Dashboard
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
