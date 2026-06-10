//! File-ownership locking. Worktrees give *physical* isolation (no shared working
//! dir); this table gives *logical* isolation so two agents never claim the same
//! file. The rule: one write owner per path. Read locks can be shared, but never
//! coexist with a write lock.

use crate::types::{FileLock, LockMode};
use parking_lot::Mutex;
use std::collections::HashMap;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum LockError {
    #[error("file '{path}' is already write-locked by '{owner}'")]
    WriteHeld { path: String, owner: String },
    #[error("file '{path}' has active read locks; cannot take a write lock")]
    ReadHeld { path: String },
}

#[derive(Default)]
pub struct LockTable {
    /// path -> set of locks on it.
    inner: Mutex<HashMap<String, Vec<FileLock>>>,
}

impl LockTable {
    pub fn new() -> Self {
        Self::default()
    }

    /// Try to claim `path` for `owner`. Write claims are exclusive; read claims
    /// coexist with other reads. Re-claiming a path you already own is a no-op.
    pub fn claim(&self, path: &str, owner: &str, mode: LockMode, ts: i64) -> Result<(), LockError> {
        let mut map = self.inner.lock();
        let entry = map.entry(path.to_string()).or_default();

        // Already owned by this owner? idempotent success.
        if entry.iter().any(|l| l.owner == owner && l.mode == mode) {
            return Ok(());
        }

        match mode {
            LockMode::Write => {
                if let Some(w) = entry.iter().find(|l| l.mode == LockMode::Write) {
                    return Err(LockError::WriteHeld {
                        path: path.to_string(),
                        owner: w.owner.clone(),
                    });
                }
                // A write lock can't coexist with reads held by *others*.
                if entry.iter().any(|l| l.mode == LockMode::Read && l.owner != owner) {
                    return Err(LockError::ReadHeld {
                        path: path.to_string(),
                    });
                }
            }
            LockMode::Read => {
                if let Some(w) = entry.iter().find(|l| l.mode == LockMode::Write && l.owner != owner) {
                    return Err(LockError::WriteHeld {
                        path: path.to_string(),
                        owner: w.owner.clone(),
                    });
                }
            }
        }

        entry.push(FileLock {
            path: path.to_string(),
            owner: owner.to_string(),
            mode,
            acquired_at: ts,
        });
        Ok(())
    }

    /// Release a specific lock held by `owner` on `path`.
    pub fn release(&self, path: &str, owner: &str) {
        let mut map = self.inner.lock();
        if let Some(entry) = map.get_mut(path) {
            entry.retain(|l| l.owner != owner);
            if entry.is_empty() {
                map.remove(path);
            }
        }
    }

    /// Release every lock held by `owner` (e.g. when an agent finishes/stops).
    pub fn release_all(&self, owner: &str) {
        let mut map = self.inner.lock();
        map.retain(|_, entry| {
            entry.retain(|l| l.owner != owner);
            !entry.is_empty()
        });
    }

    /// The write owner of a path, if any.
    pub fn write_owner(&self, path: &str) -> Option<String> {
        let map = self.inner.lock();
        map.get(path)
            .and_then(|e| e.iter().find(|l| l.mode == LockMode::Write))
            .map(|l| l.owner.clone())
    }

    /// Snapshot of all current locks (for the topology view).
    pub fn snapshot(&self) -> Vec<FileLock> {
        let map = self.inner.lock();
        map.values().flatten().cloned().collect()
    }

    /// Claim several paths atomically for an owner: if any conflict, none are
    /// taken. Used when assigning a task's whole file set to one agent.
    pub fn claim_all(&self, paths: &[String], owner: &str, mode: LockMode, ts: i64) -> Result<(), LockError> {
        // Pre-check under a single lock to keep it atomic.
        let mut map = self.inner.lock();
        for path in paths {
            if let Some(entry) = map.get(path) {
                let conflict = match mode {
                    LockMode::Write => entry
                        .iter()
                        .any(|l| (l.mode == LockMode::Write && l.owner != owner) || (l.mode == LockMode::Read && l.owner != owner)),
                    LockMode::Read => entry.iter().any(|l| l.mode == LockMode::Write && l.owner != owner),
                };
                if conflict {
                    let owner_of = entry.first().map(|l| l.owner.clone()).unwrap_or_default();
                    return Err(LockError::WriteHeld {
                        path: path.clone(),
                        owner: owner_of,
                    });
                }
            }
        }
        for path in paths {
            let entry = map.entry(path.clone()).or_default();
            if !entry.iter().any(|l| l.owner == owner && l.mode == mode) {
                entry.push(FileLock {
                    path: path.clone(),
                    owner: owner.to_string(),
                    mode,
                    acquired_at: ts,
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_lock_is_exclusive() {
        let t = LockTable::new();
        assert!(t.claim("a.rs", "agent1", LockMode::Write, 1).is_ok());
        let err = t.claim("a.rs", "agent2", LockMode::Write, 2).unwrap_err();
        assert_eq!(
            err,
            LockError::WriteHeld {
                path: "a.rs".into(),
                owner: "agent1".into()
            }
        );
        assert_eq!(t.write_owner("a.rs").as_deref(), Some("agent1"));
    }

    #[test]
    fn reclaim_is_idempotent() {
        let t = LockTable::new();
        assert!(t.claim("a.rs", "agent1", LockMode::Write, 1).is_ok());
        assert!(t.claim("a.rs", "agent1", LockMode::Write, 2).is_ok());
        assert_eq!(t.snapshot().len(), 1);
    }

    #[test]
    fn release_frees_the_path() {
        let t = LockTable::new();
        t.claim("a.rs", "agent1", LockMode::Write, 1).unwrap();
        t.release("a.rs", "agent1");
        assert!(t.write_owner("a.rs").is_none());
        assert!(t.claim("a.rs", "agent2", LockMode::Write, 3).is_ok());
    }

    #[test]
    fn release_all_clears_an_owner() {
        let t = LockTable::new();
        t.claim("a.rs", "agent1", LockMode::Write, 1).unwrap();
        t.claim("b.rs", "agent1", LockMode::Write, 1).unwrap();
        t.claim("c.rs", "agent2", LockMode::Write, 1).unwrap();
        t.release_all("agent1");
        assert!(t.write_owner("a.rs").is_none());
        assert!(t.write_owner("b.rs").is_none());
        assert_eq!(t.write_owner("c.rs").as_deref(), Some("agent2"));
    }

    #[test]
    fn reads_are_shared_but_block_foreign_writes() {
        let t = LockTable::new();
        assert!(t.claim("a.rs", "r1", LockMode::Read, 1).is_ok());
        assert!(t.claim("a.rs", "r2", LockMode::Read, 1).is_ok());
        // a write by someone else is blocked while reads are held
        assert!(t.claim("a.rs", "w1", LockMode::Write, 1).is_err());
    }

    #[test]
    fn claim_all_is_atomic() {
        let t = LockTable::new();
        t.claim("b.rs", "other", LockMode::Write, 1).unwrap();
        // agent1 wants a.rs + b.rs, but b.rs is taken -> nothing is claimed
        let res = t.claim_all(&["a.rs".into(), "b.rs".into()], "agent1", LockMode::Write, 2);
        assert!(res.is_err());
        assert!(t.write_owner("a.rs").is_none(), "a.rs must not be claimed on partial failure");
    }
}
