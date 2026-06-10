//! Diagnostics & logging. One `tracing` backbone fans out to three sinks so that
//! when a run works or fails, there is always enough information on disk to
//! investigate after the fact:
//!
//!   1. a daily-rolling file  `<log_dir>/synapse.log`  (everything, all runs)
//!   2. an in-memory ring buffer the desktop UI shows live and slices into a
//!      clean per-run file `<log_dir>/run-<id>.log`
//!   3. (optionally) stdout
//!
//! Logs are LOCAL and intentionally UNREDACTED — the whole point is full
//! diagnostic detail for investigation. They never leave the machine.

use crate::util::now_ms;
use parking_lot::Mutex;
use serde::Serialize;
use std::fmt::Write as _;
use std::path::Path;
use std::sync::Arc;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::EnvFilter;

/// One captured log record.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub ts: i64,
    pub level: String,
    pub target: String,
    pub message: String,
}

impl LogLine {
    /// Render as a single text line for the per-run log file.
    pub fn render(&self) -> String {
        format!("{} {:<5} {} — {}", self.ts, self.level, self.target, self.message)
    }
}

pub type LogBuffer = Arc<Mutex<Vec<LogLine>>>;

/// Visits an event's fields, pulling out the `message` and appending the rest as
/// `key=value` pairs.
struct FieldVisitor {
    message: String,
    extra: String,
}

impl Visit for FieldVisitor {
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message.push_str(value);
        } else {
            let _ = write!(self.extra, " {}={}", field.name(), value);
        }
    }
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            let _ = write!(self.message, "{:?}", value);
        } else {
            let _ = write!(self.extra, " {}={:?}", field.name(), value);
        }
    }
}

/// A tracing layer that appends every event into a shared, capped buffer.
struct CaptureLayer {
    buf: LogBuffer,
    cap: usize,
}

impl<S> Layer<S> for CaptureLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut v = FieldVisitor {
            message: String::new(),
            extra: String::new(),
        };
        event.record(&mut v);
        let meta = event.metadata();
        let line = LogLine {
            ts: now_ms(),
            level: meta.level().to_string(),
            target: meta.target().to_string(),
            message: format!("{}{}", v.message, v.extra),
        };
        let mut b = self.buf.lock();
        b.push(line);
        let len = b.len();
        if len > self.cap {
            b.drain(0..(len - self.cap));
        }
    }
}

/// Keeps the non-blocking file writer alive for the process lifetime. Drop it on
/// shutdown to flush.
pub struct LogGuard {
    _appender: tracing_appender::non_blocking::WorkerGuard,
}

/// Initialise global logging. `console` adds a stdout sink (off for the CLI so
/// its report stays clean; on for the desktop). Returns the guard (keep alive)
/// and the shared capture buffer. Safe to call once per process; subsequent
/// calls are no-ops.
pub fn init(log_dir: &Path, console: bool) -> std::io::Result<(LogGuard, LogBuffer)> {
    std::fs::create_dir_all(log_dir)?;
    let file_appender = tracing_appender::rolling::daily(log_dir, "synapse.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);

    let buf: LogBuffer = Arc::new(Mutex::new(Vec::new()));

    let filter = EnvFilter::try_from_env("SYNAPSE_LOG").unwrap_or_else(|_| {
        EnvFilter::new("info,synapse_core=debug,synapse_desktop=debug,synapse=debug")
    });

    let file_layer = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_writer(non_blocking);

    // `Option<Layer>` is itself a Layer, so this cleanly toggles stdout.
    let stdout_layer = console.then(|| {
        tracing_subscriber::fmt::layer()
            .with_ansi(true)
            .with_target(false)
    });

    let capture = CaptureLayer {
        buf: buf.clone(),
        cap: 10_000,
    };

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stdout_layer)
        .with(capture)
        .try_init();

    // Make panics land in the log instead of vanishing.
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!(target: "panic", "{}", info);
        prev(info);
    }));

    Ok((LogGuard { _appender: guard }, buf))
}

/// Write a slice of log lines to a dedicated per-run file. Returns the path.
pub fn write_run_log(log_dir: &Path, run_id: &str, lines: &[LogLine]) -> std::io::Result<std::path::PathBuf> {
    std::fs::create_dir_all(log_dir)?;
    let path = log_dir.join(format!("run-{run_id}.log"));
    let mut body = String::with_capacity(lines.len() * 80);
    for l in lines {
        body.push_str(&l.render());
        body.push('\n');
    }
    std::fs::write(&path, body)?;
    Ok(path)
}

/// The default log directory: `~/.synapse/logs`.
pub fn default_log_dir() -> std::path::PathBuf {
    let home = std::env::var("USERPROFILE")
        .ok()
        .or_else(|| std::env::var("HOME").ok())
        .unwrap_or_else(|| ".".to_string());
    std::path::Path::new(&home).join(".synapse").join("logs")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_layer_records_events() {
        let buf: LogBuffer = Arc::new(Mutex::new(Vec::new()));
        let layer = CaptureLayer {
            buf: buf.clone(),
            cap: 100,
        };
        let subscriber = tracing_subscriber::registry().with(layer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(agent = "coder-1", "spawned");
            tracing::warn!("careful");
        });
        let lines = buf.lock();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].message.contains("spawned"));
        assert!(lines[0].message.contains("agent=coder-1"), "{}", lines[0].message);
        assert_eq!(lines[1].level, "WARN");
    }

    #[test]
    fn run_log_is_written() {
        let dir = tempfile::tempdir().unwrap();
        let lines = vec![LogLine {
            ts: 1,
            level: "INFO".into(),
            target: "synapse_core::orchestrator".into(),
            message: "assigned task=t1 agent=coder-1".into(),
        }];
        let path = write_run_log(dir.path(), "abc123", &lines).unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("assigned task=t1 agent=coder-1"));
        assert!(path.ends_with("run-abc123.log"));
    }
}
