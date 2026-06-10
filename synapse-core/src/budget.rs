//! Budget governor. Tracks a rolling window of token usage so the orchestrator
//! can warn (or soft-block) before a fleet of agents blows the 5-hour rate limit.
//! Ported in spirit from ClaudeConnect's RollingUsageSummary.

use parking_lot::Mutex;
use std::collections::VecDeque;

/// 5 hours in milliseconds — Anthropic's rate-limit window.
pub const WINDOW_MS: i64 = 5 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy)]
struct Turn {
    ts: i64,
    /// Billable tokens: input + cache_creation + output (cache reads are free).
    billable: i64,
}

/// A spawn decision recommendation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BudgetVerdict {
    Ok,
    /// Approaching the soft cap; surface a warning but allow.
    Warn,
    /// Over the soft cap; recommend blocking new spawns.
    Over,
}

pub struct Budget {
    turns: Mutex<VecDeque<Turn>>,
    /// Soft cap on billable tokens within the window. None = unlimited.
    soft_cap: Mutex<Option<i64>>,
    /// Soft cap on number of concurrently active agents. None = unlimited.
    agent_cap: Mutex<Option<u32>>,
}

impl Budget {
    pub fn new(soft_cap: Option<i64>, agent_cap: Option<u32>) -> Self {
        Budget {
            turns: Mutex::new(VecDeque::new()),
            soft_cap: Mutex::new(soft_cap),
            agent_cap: Mutex::new(agent_cap),
        }
    }

    pub fn record(&self, ts: i64, billable: i64) {
        let mut t = self.turns.lock();
        t.push_back(Turn { ts, billable });
        // prune anything older than the window relative to the newest ts
        let cutoff = ts - WINDOW_MS;
        while let Some(front) = t.front() {
            if front.ts < cutoff {
                t.pop_front();
            } else {
                break;
            }
        }
        // pathological-input safety net
        while t.len() > 5000 {
            t.pop_front();
        }
    }

    /// Total billable tokens within the window ending at `now`.
    pub fn billable_in_window(&self, now: i64) -> i64 {
        let cutoff = now - WINDOW_MS;
        self.turns
            .lock()
            .iter()
            .filter(|t| t.ts >= cutoff)
            .map(|t| t.billable)
            .sum()
    }

    /// Verdict on token usage at time `now`. Warn at 80% of the soft cap.
    pub fn token_verdict(&self, now: i64) -> BudgetVerdict {
        let cap = match *self.soft_cap.lock() {
            Some(c) if c > 0 => c,
            _ => return BudgetVerdict::Ok,
        };
        let used = self.billable_in_window(now);
        if used >= cap {
            BudgetVerdict::Over
        } else if used as f64 >= cap as f64 * 0.8 {
            BudgetVerdict::Warn
        } else {
            BudgetVerdict::Ok
        }
    }

    /// Verdict on spawning `active + wanted` agents.
    pub fn agent_verdict(&self, active: u32, wanted: u32) -> BudgetVerdict {
        let cap = match *self.agent_cap.lock() {
            Some(c) if c > 0 => c,
            _ => return BudgetVerdict::Ok,
        };
        let total = active + wanted;
        if total > cap {
            BudgetVerdict::Over
        } else if total == cap {
            BudgetVerdict::Warn
        } else {
            BudgetVerdict::Ok
        }
    }

    pub fn set_soft_cap(&self, cap: Option<i64>) {
        *self.soft_cap.lock() = cap;
    }

    pub fn set_agent_cap(&self, cap: Option<u32>) {
        *self.agent_cap.lock() = cap;
    }
}

impl Default for Budget {
    fn default() -> Self {
        // Sensible defaults: warn-only governance, 8-agent soft cap.
        Budget::new(None, Some(8))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prunes_outside_window() {
        let b = Budget::new(None, None);
        b.record(0, 1000);
        b.record(WINDOW_MS + 1, 500);
        // the first turn aged out
        assert_eq!(b.billable_in_window(WINDOW_MS + 1), 500);
    }

    #[test]
    fn token_verdict_ok_below_threshold() {
        let b = Budget::new(Some(1000), None);
        b.record(0, 700);
        // 700 < 80% of 1000 (800) -> Ok
        assert_eq!(b.token_verdict(0), BudgetVerdict::Ok);
    }

    #[test]
    fn token_verdict_warn_and_over() {
        let b = Budget::new(Some(1000), None);
        b.record(0, 850);
        assert_eq!(b.token_verdict(0), BudgetVerdict::Warn); // 85% >= 80%
        b.record(1, 200);
        assert_eq!(b.token_verdict(1), BudgetVerdict::Over); // 1050 >= 1000
    }

    #[test]
    fn agent_verdict_caps() {
        let b = Budget::new(None, Some(5));
        assert_eq!(b.agent_verdict(2, 2), BudgetVerdict::Ok); // 4 < 5
        assert_eq!(b.agent_verdict(4, 1), BudgetVerdict::Warn); // == 5
        assert_eq!(b.agent_verdict(5, 1), BudgetVerdict::Over); // 6 > 5
    }
}
