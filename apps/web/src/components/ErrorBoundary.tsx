import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Rendered instead of the children once one of them throws while rendering. */
  fallback: (error: unknown, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface State {
  error: { value: unknown } | null;
}

/** React error boundary (these still need a class). `reset` clears the error and remounts the children. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: { value: error } };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("Rendering failed", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  override render(): ReactNode {
    return this.state.error
      ? this.props.fallback(this.state.error.value, this.reset)
      : this.props.children;
  }
}
