//! Inter-agent mailbox. Async point-to-point (and broadcast) messages, the
//! coordination substrate the Director and agents use. Discipline: messages only
//! when they advance the goal — agents ship code first, send messages second.

use crate::types::MailboxMessage;
use crate::util::{new_id, now_ms};
use parking_lot::Mutex;

/// Broadcast recipient sentinel.
pub const BROADCAST: &str = "*";

#[derive(Default)]
pub struct Mailbox {
    inner: Mutex<Vec<MailboxMessage>>,
}

impl Mailbox {
    pub fn new() -> Self {
        Self::default()
    }

    /// Send a message. Returns its id.
    pub fn send(&self, from: &str, to: &str, body: &str) -> String {
        self.send_at(from, to, body, now_ms())
    }

    /// Send with an explicit timestamp (deterministic tests).
    pub fn send_at(&self, from: &str, to: &str, body: &str, ts: i64) -> String {
        let id = new_id();
        self.inner.lock().push(MailboxMessage {
            id: id.clone(),
            from: from.to_string(),
            to: to.to_string(),
            body: body.to_string(),
            ts,
            read: false,
        });
        id
    }

    /// All messages addressed to `agent` (direct or broadcast), in order.
    pub fn inbox(&self, agent: &str) -> Vec<MailboxMessage> {
        self.inner
            .lock()
            .iter()
            .filter(|m| m.to == agent || m.to == BROADCAST)
            .cloned()
            .collect()
    }

    /// Unread messages for `agent`. A broadcast counts as read for an agent once
    /// that agent has marked it read (tracked per message id below — broadcasts
    /// are shared, so "read" here means globally read; for per-agent read state
    /// the UI tracks last-seen separately).
    pub fn unread(&self, agent: &str) -> Vec<MailboxMessage> {
        self.inner
            .lock()
            .iter()
            .filter(|m| (m.to == agent || m.to == BROADCAST) && !m.read)
            .cloned()
            .collect()
    }

    /// Mark a message read.
    pub fn mark_read(&self, id: &str) {
        if let Some(m) = self.inner.lock().iter_mut().find(|m| m.id == id) {
            m.read = true;
        }
    }

    /// Every message (for the UI feed / persistence).
    pub fn all(&self) -> Vec<MailboxMessage> {
        self.inner.lock().clone()
    }

    pub fn len(&self) -> usize {
        self.inner.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.inner.lock().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_messages_route_to_recipient() {
        let mb = Mailbox::new();
        mb.send_at("director", "coder-1", "implement auth", 1);
        mb.send_at("director", "coder-2", "implement ui", 2);
        let inbox = mb.inbox("coder-1");
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].body, "implement auth");
    }

    #[test]
    fn broadcast_reaches_everyone() {
        let mb = Mailbox::new();
        mb.send_at("director", BROADCAST, "freeze the schema", 1);
        assert_eq!(mb.inbox("coder-1").len(), 1);
        assert_eq!(mb.inbox("coder-2").len(), 1);
    }

    #[test]
    fn unread_then_read() {
        let mb = Mailbox::new();
        let id = mb.send_at("a", "b", "hi", 1);
        assert_eq!(mb.unread("b").len(), 1);
        mb.mark_read(&id);
        assert_eq!(mb.unread("b").len(), 0);
        assert_eq!(mb.inbox("b").len(), 1);
    }
}
