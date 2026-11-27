import { Component, type ErrorInfo, type ReactNode } from "react";

export interface RenderErrorFallbackProps {
  readonly error: Error;
  readonly label: string;
  readonly reset: () => void;
}

export interface RenderErrorBoundaryProps {
  readonly label: string;
  /** Identity values whose change resets a caught failure automatically. */
  readonly resetKeys?: readonly unknown[];
  readonly align?: "center" | "start";
  readonly onError?: (error: Error, info: ErrorInfo) => void;
  readonly fallback?: (props: RenderErrorFallbackProps) => ReactNode;
  readonly children: ReactNode;
}

interface RenderErrorBoundaryState {
  readonly error: Error | null;
  readonly prevResetKeys: readonly unknown[] | undefined;
}

function keysChanged(
  previous: readonly unknown[] | undefined,
  next: readonly unknown[] | undefined,
): boolean {
  if (previous === next) return false;
  if (!previous || !next || previous.length !== next.length) return true;
  for (let i = 0; i < previous.length; i += 1) {
    if (!Object.is(previous[i], next[i])) return true;
  }
  return false;
}

/** Isolates React render failures to a single pane or region with an inline retry action. */
export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  override state: RenderErrorBoundaryState = {
    error: null,
    prevResetKeys: this.props.resetKeys,
  };

  static getDerivedStateFromProps(
    props: RenderErrorBoundaryProps,
    state: RenderErrorBoundaryState,
  ): Partial<RenderErrorBoundaryState> | null {
    if (!keysChanged(state.prevResetKeys, props.resetKeys)) return null;
    return {
      error: null,
      prevResetKeys: props.resetKeys,
    };
  }

  static getDerivedStateFromError(error: unknown): Partial<RenderErrorBoundaryState> {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.(error, info);
  }

  private readonly reset = (): void => {
    this.setState({ error: null, prevResetKeys: this.props.resetKeys });
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) {
      return this.props.fallback({ error, label: this.props.label, reset: this.reset });
    }
    const align = this.props.align ?? "center";
    return (
      <div className="wb-error-state" data-align={align} role="alert" data-wb-error-boundary="">
        <p className="wb-error-state-title">{this.props.label} encountered a rendering error</p>
        <p className="wb-error-state-detail">{error.message}</p>
        <button type="button" className="wb-button" onClick={this.reset}>
          Retry
        </button>
      </div>
    );
  }
}
