//! Dev tool: parse a Claude Code session JSONL into the same Message JSON the
//! desktop app's tailer serves, for the browser preview harness.
//!   cargo run --example dump_transcript -- <in.jsonl> [max_lines] > out.json
use synapse_core::transcript::parse_line;

fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("usage: dump_transcript <in.jsonl> [max_lines]");
    let max: usize = args.next().and_then(|s| s.parse().ok()).unwrap_or(usize::MAX);
    let text = std::fs::read_to_string(&path).expect("read transcript");
    let mut out = Vec::new();
    for (i, line) in text.lines().filter(|l| !l.trim().is_empty()).take(max).enumerate() {
        out.extend(parse_line(line, i as i64 + 1, None));
    }
    println!("{}", serde_json::to_string(&out).unwrap());
}
