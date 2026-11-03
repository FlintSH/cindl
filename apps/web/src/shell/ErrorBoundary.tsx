import { Component, type ErrorInfo, type ReactNode } from 'react'
import styles from './shell.module.css'

/**
 * Contains a rendering failure to one region so the rest of the shell keeps
 * working. Shows no error detail: agent and account data can appear in
 * messages, and this is not a debugging surface.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; label: string },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo) {
    // Cindl adds no logging or reporting of its own: messages may contain
    // private content. React itself still prints caught errors to the local
    // browser console; nothing leaves the device.
  }

  override render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className={styles.failure} role="alert">
        <p>Something went wrong showing {this.props.label}.</p>
        <p className={styles.failureHint}>Your conversation and Hermes are unaffected.</p>
        <div className={styles.failureActions}>
          <a href="#/talk" onClick={() => this.setState({ failed: false })}>
            Go to Talk
          </a>
          <button
            type="button"
            className={styles.failureButton}
            onClick={() => window.location.reload()}
          >
            Reload Cindl
          </button>
        </div>
      </div>
    )
  }
}
