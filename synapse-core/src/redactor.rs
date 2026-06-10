//! PII / secret redactor. Ported from ClaudeConnect's `redactor.rs`: loads a
//! JSON config of regex patterns + literal deny-list strings, applies them to
//! free-text fields, and counts substitutions.
//!
//! Behaviour preserved from the original:
//!   * Patterns run before deny-list literals — order matters because some
//!     patterns match against the `<email>` / `<uid>` placeholders earlier
//!     patterns produced.
//!   * Per-pattern counts are bucketed by pattern name.
//!   * Default replacement = `<name>` if the config entry omits one.

use anyhow::{Context, Result};
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct Pattern {
    pub name: String,
    pub re: Regex,
    pub replacement: String,
}

#[derive(Debug, Clone)]
pub struct Deny {
    pub name: String,
    pub needle: String,
    pub replacement: String,
}

#[derive(Debug, Clone, Default)]
pub struct RedactorConfig {
    pub patterns: Vec<Pattern>,
    pub deny_list: Vec<Deny>,
}

impl RedactorConfig {
    pub fn pattern_count(&self) -> usize {
        self.patterns.len()
    }

    /// Build a config from a parsed JSON value (same shape as
    /// redactor-config.default.json). Malformed patterns are skipped, never
    /// fatal — we don't want the redactor to fail open on one bad regex.
    pub fn from_value(value: &Value) -> Self {
        let mut cfg = RedactorConfig::default();
        if let Some(arr) = value.get("patterns").and_then(|v| v.as_array()) {
            for p in arr {
                let Some(name) = p.get("name").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(regex_src) = p.get("regex").and_then(|v| v.as_str()) else {
                    continue;
                };
                let flags = p.get("flags").and_then(|v| v.as_str()).unwrap_or("g");
                let replacement = p
                    .get("replacement")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("<{}>", name));
                match compile_regex(regex_src, flags) {
                    Ok(re) => cfg.patterns.push(Pattern {
                        name: name.to_string(),
                        re,
                        replacement,
                    }),
                    Err(e) => eprintln!("[redactor] skipping pattern '{}': {}", name, e),
                }
            }
        }
        if let Some(arr) = value.get("denyList").and_then(|v| v.as_array()) {
            for d in arr {
                let Some(name) = d.get("name").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(needle) = d.get("needle").and_then(|v| v.as_str()) else {
                    continue;
                };
                let replacement = d
                    .get("replacement")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .unwrap_or_else(|| format!("<{}>", name));
                cfg.deny_list.push(Deny {
                    name: name.to_string(),
                    needle: needle.to_string(),
                    replacement,
                });
            }
        }
        cfg
    }

    /// The built-in default policy. Used when no config file is present so the
    /// engine is never un-redacted by accident.
    pub fn builtin_default() -> Self {
        let v: Value = serde_json::from_str(DEFAULT_CONFIG_JSON)
            .expect("builtin default redactor config is valid JSON");
        Self::from_value(&v)
    }
}

/// Read a `redactor-config.json` from disk and compile it.
pub fn load_config(path: &Path) -> Result<RedactorConfig> {
    let raw = std::fs::read_to_string(path)
        .with_context(|| format!("read redactor config at {}", path.display()))?;
    let value: Value =
        serde_json::from_str(&raw).with_context(|| "parse redactor config as JSON")?;
    Ok(RedactorConfig::from_value(&value))
}

/// Translate JS-style regex flags into `regex` crate inline flags. `g` has no
/// Rust equivalent (replace_all is always global) so it's ignored.
fn compile_regex(src: &str, flags: &str) -> Result<Regex> {
    let mut prefix = String::new();
    let (mut i, mut m, mut s) = (false, false, false);
    for c in flags.chars() {
        match c {
            'i' => i = true,
            'm' => m = true,
            's' => s = true,
            _ => {}
        }
    }
    if i || m || s {
        prefix.push_str("(?");
        if i {
            prefix.push('i');
        }
        if m {
            prefix.push('m');
        }
        if s {
            prefix.push('s');
        }
        prefix.push(')');
    }
    let full = format!("{}{}", prefix, src);
    Regex::new(&full).with_context(|| format!("compile regex `{}`", full))
}

#[derive(Debug, Clone, Default)]
pub struct RedactString {
    pub value: String,
    pub counts: HashMap<String, u32>,
}

impl RedactString {
    pub fn total(&self) -> u32 {
        self.counts.values().sum()
    }
}

/// Redact a single string: every pattern in order, then every deny-list needle.
pub fn redact_string(s: &str, config: &RedactorConfig) -> RedactString {
    let mut result = s.to_string();
    let mut counts: HashMap<String, u32> = HashMap::new();

    for p in &config.patterns {
        if !p.re.is_match(&result) {
            continue;
        }
        let mut hits = 0u32;
        let replaced = p
            .re
            .replace_all(&result, |_caps: &regex::Captures| {
                hits += 1;
                p.replacement.clone()
            })
            .to_string();
        if hits > 0 {
            *counts.entry(p.name.clone()).or_insert(0) += hits;
        }
        result = replaced;
    }

    for d in &config.deny_list {
        if d.needle.is_empty() {
            continue;
        }
        let n = result.matches(&d.needle).count() as u32;
        if n == 0 {
            continue;
        }
        *counts.entry(d.name.clone()).or_insert(0) += n;
        result = result.replace(&d.needle, &d.replacement);
    }

    RedactString {
        value: result,
        counts,
    }
}

pub fn merge_counts(target: &mut HashMap<String, u32>, more: &HashMap<String, u32>) {
    for (k, v) in more {
        *target.entry(k.clone()).or_insert(0) += v;
    }
}

/// Recursive deep-redact of a JSON value. Strings redacted; numbers/bools/null
/// untouched; arrays + objects recursed (keys preserved).
pub fn redact_deep(obj: &Value, config: &RedactorConfig, counts: &mut HashMap<String, u32>) -> Value {
    match obj {
        Value::String(s) => {
            let r = redact_string(s, config);
            merge_counts(counts, &r.counts);
            Value::String(r.value)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(|v| redact_deep(v, config, counts)).collect()),
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), redact_deep(v, config, counts));
            }
            Value::Object(out)
        }
        _ => obj.clone(),
    }
}

/// The default redaction policy, embedded so the engine ships redacted-by-default.
/// Shape-based (not name-based) so every user gets the same protection.
pub const DEFAULT_CONFIG_JSON: &str = r#"{
  "patterns": [
    { "name": "email", "regex": "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}", "replacement": "<email>" },
    { "name": "anthropic_key", "regex": "sk-ant-[a-zA-Z0-9_-]{20,}", "replacement": "<anthropic_key>" },
    { "name": "openai_key", "regex": "sk-[a-zA-Z0-9]{20,}", "replacement": "<openai_key>" },
    { "name": "bearer", "regex": "(?i)bearer\\s+[a-zA-Z0-9._-]{20,}", "replacement": "<bearer>" },
    { "name": "github_token", "regex": "gh[pousr]_[A-Za-z0-9]{20,}", "replacement": "<github_token>" },
    { "name": "aws_key", "regex": "AKIA[0-9A-Z]{16}", "replacement": "<aws_key>" },
    { "name": "firebase_uid", "regex": "\\b[a-zA-Z0-9]{28}\\b", "replacement": "<uid>" },
    { "name": "user_path", "regex": "[A-Za-z]:\\\\Users\\\\[^\\\\\\s]+", "replacement": "C:/Users/<user>" },
    { "name": "unix_home", "regex": "/(?:home|Users)/[a-zA-Z0-9._-]+", "replacement": "/home/<user>" }
  ],
  "denyList": []
}"#;

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> RedactorConfig {
        RedactorConfig::builtin_default()
    }

    #[test]
    fn default_config_compiles() {
        let c = cfg();
        assert!(c.pattern_count() >= 8, "expected the default patterns to load");
    }

    #[test]
    fn redacts_email_and_keys() {
        let c = cfg();
        let r = redact_string("contact jane.doe@example.com or use sk-ant-abcdefghijklmnopqrstuvwxyz123", &c);
        assert!(r.value.contains("<email>"), "{}", r.value);
        assert!(r.value.contains("<anthropic_key>"), "{}", r.value);
        assert!(!r.value.contains("jane.doe@example.com"));
        assert!(r.total() >= 2);
    }

    #[test]
    fn redacts_windows_user_path() {
        let c = cfg();
        let r = redact_string("see C:\\Users\\Chris\\.claude\\projects", &c);
        assert!(r.value.contains("C:/Users/<user>"), "{}", r.value);
        assert!(!r.value.contains("Chris"));
    }

    #[test]
    fn deep_redacts_nested_json() {
        let c = cfg();
        let v: Value = serde_json::json!({
            "a": "mail me at bob@corp.io",
            "b": [ "nothing", "token sk-ant-zzzzzzzzzzzzzzzzzzzzzzzz" ],
            "n": 42
        });
        let mut counts = HashMap::new();
        let out = redact_deep(&v, &c, &mut counts);
        let s = serde_json::to_string(&out).unwrap();
        assert!(s.contains("<email>"), "{}", s);
        assert!(s.contains("<anthropic_key>"), "{}", s);
        assert!(s.contains("42"));
        assert!(counts.values().sum::<u32>() >= 2);
    }

    #[test]
    fn deny_list_strips_literals() {
        let v = serde_json::json!({
            "patterns": [],
            "denyList": [ { "name": "codename", "needle": "ProjectFalcon", "replacement": "<project>" } ]
        });
        let c = RedactorConfig::from_value(&v);
        let r = redact_string("deploy ProjectFalcon now", &c);
        assert_eq!(r.value, "deploy <project> now");
    }
}
