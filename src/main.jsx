import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import AuthGate from "./AuthGate.jsx";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// A render crash without a boundary blanks the whole window (WebView2 shows
// white). This turns any uncaught render error into a readable card instead.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Synapse render crash:", error, info?.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="crash">
          <div className="crash-card">
            <div className="crash-title">Something broke in the UI</div>
            <pre className="crash-detail">{String(this.state.error?.message || this.state.error)}</pre>
            <button className="crash-btn" onClick={() => window.location.reload()}>↻ Reload Synapse</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErrorBoundary>
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </React.StrictMode>
);
