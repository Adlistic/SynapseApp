//! Small shared helpers: ids and wall-clock time.

use std::time::{SystemTime, UNIX_EPOCH};

/// Milliseconds since the unix epoch. Used for timestamps on messages, locks,
/// mailbox entries, etc. Functions that need deterministic output in tests take
/// an explicit `ts` instead of calling this.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A fresh random id (uuid v4, hyphenated).
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A short id — first 8 chars of a uuid v4. Handy for branch names / labels.
pub fn short_id() -> String {
    let id = uuid::Uuid::new_v4().to_string();
    id.split('-').next().unwrap_or(&id).to_string()
}

/// Slugify an arbitrary string into something safe for a git branch / path
/// component: lowercase, alnum runs joined by single hyphens, trimmed.
pub fn slug(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = true; // avoids leading dash
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "agent".to_string()
    } else {
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_branch_safe() {
        assert_eq!(slug("Backend Developer"), "backend-developer");
        assert_eq!(slug("  Fix the AUTH bug!! "), "fix-the-auth-bug");
        assert_eq!(slug("///"), "agent");
        assert_eq!(slug("coder-1"), "coder-1");
    }

    #[test]
    fn ids_are_unique() {
        assert_ne!(new_id(), new_id());
        assert_eq!(short_id().len(), 8);
    }

    #[test]
    fn now_ms_is_positive() {
        assert!(now_ms() > 1_700_000_000_000);
    }
}
