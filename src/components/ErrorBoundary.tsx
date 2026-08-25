import React from 'react';

interface Props { children: React.ReactNode }
interface State { hasError: boolean; error?: Error }

export class ErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary]', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-black text-white p-8" role="alert" aria-live="assertive">
          <div className="max-w-md w-full rounded-2xl bg-white/[0.04] border border-white/10 p-6 text-center">
            <h2 className="text-lg font-mono font-bold">Something went wrong</h2>
            <p className="text-xs font-mono text-white/50 mt-2 break-words">{this.state.error?.message || 'Unknown error'}</p>
            <button
              // eslint-disable-next-line react/no-unescaped-entities
              onClick={() => { this.setState({ hasError: false }); window.location.reload(); }}
              className="mt-4 px-4 py-2 rounded-lg bg-white text-black text-xs font-mono font-bold hover:bg-white/90"
              autoFocus
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
