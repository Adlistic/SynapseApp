//! Git worktree management — the physical isolation primitive. One worktree +
//! branch per agent, so two agents physically cannot edit the same working tree.
//! Shells out to the `git` binary (matches how most ADE tooling does it; libgit2
//! lags on worktree porcelain).

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Run a git command rooted at `cwd`, returning trimmed stdout. Errors include
/// stderr so failures are diagnosable.
fn git(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .with_context(|| format!("spawn git {:?}", args))?;
    if !out.status.success() {
        bail!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub struct WorktreeManager {
    /// The main repository root.
    pub root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
}

impl WorktreeManager {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        WorktreeManager { root: root.into() }
    }

    /// True if `root` is inside a git work tree.
    pub fn is_git_repo(&self) -> bool {
        git(&self.root, &["rev-parse", "--is-inside-work-tree"])
            .map(|s| s == "true")
            .unwrap_or(false)
    }

    /// Initialise a repo at `root` (used in tests / first-run). Sets a local
    /// identity so commits work in headless/CI environments.
    pub fn init(&self) -> Result<()> {
        std::fs::create_dir_all(&self.root).ok();
        git(&self.root, &["init", "-q", "-b", "main"])?;
        git(&self.root, &["config", "user.email", "synapse@local"])?;
        git(&self.root, &["config", "user.name", "Synapse"])?;
        Ok(())
    }

    /// Stage everything and commit. Returns the new commit hash.
    pub fn commit_all(&self, msg: &str) -> Result<String> {
        git(&self.root, &["add", "-A"])?;
        git(&self.root, &["commit", "-q", "-m", msg, "--allow-empty"])?;
        git(&self.root, &["rev-parse", "HEAD"])
    }

    /// Create a worktree at `path` on a new `branch`, branched from `base`
    /// (defaults to HEAD). Returns the absolute worktree path.
    pub fn add(&self, branch: &str, path: &Path, base: Option<&str>) -> Result<PathBuf> {
        let path_str = path.to_string_lossy().to_string();
        let base = base.unwrap_or("HEAD");
        git(
            &self.root,
            &["worktree", "add", "-b", branch, &path_str, base],
        )?;
        Ok(path.to_path_buf())
    }

    /// Remove a worktree (force, since agents leave uncommitted work).
    pub fn remove(&self, path: &Path) -> Result<()> {
        let path_str = path.to_string_lossy().to_string();
        git(&self.root, &["worktree", "remove", "--force", &path_str])?;
        Ok(())
    }

    /// List worktrees (porcelain parse).
    pub fn list(&self) -> Result<Vec<WorktreeInfo>> {
        let out = git(&self.root, &["worktree", "list", "--porcelain"])?;
        let mut infos = Vec::new();
        let mut cur_path = None;
        for line in out.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                cur_path = Some(p.to_string());
            } else if let Some(b) = line.strip_prefix("branch ") {
                if let Some(p) = cur_path.take() {
                    let branch = b.strip_prefix("refs/heads/").unwrap_or(b).to_string();
                    infos.push(WorktreeInfo { path: p, branch });
                }
            } else if line.is_empty() {
                cur_path = None;
            }
        }
        Ok(infos)
    }

    /// Working-tree status (porcelain) for a worktree path — shows uncommitted
    /// and untracked changes an agent has produced.
    pub fn status(&self, worktree_path: &Path) -> Result<String> {
        git(worktree_path, &["status", "--porcelain"])
    }

    /// Diff of a branch against `base` (committed changes), for the auditor.
    pub fn diff(&self, base: &str, branch: &str) -> Result<String> {
        git(&self.root, &["diff", &format!("{}...{}", base, branch)])
    }

    /// Merge `branch` into the current branch of the main root (squash-free,
    /// fast path). The auditor gate decides whether this is called.
    pub fn merge(&self, branch: &str) -> Result<()> {
        git(&self.root, &["merge", "--no-edit", branch])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_repo() -> (tempfile::TempDir, WorktreeManager) {
        let dir = tempfile::tempdir().unwrap();
        let wm = WorktreeManager::new(dir.path());
        wm.init().unwrap();
        fs::write(dir.path().join("README.md"), "seed").unwrap();
        wm.commit_all("seed").unwrap();
        (dir, wm)
    }

    #[test]
    fn init_makes_a_repo() {
        let (_d, wm) = temp_repo();
        assert!(wm.is_git_repo());
    }

    #[test]
    fn add_and_list_worktrees() {
        let (dir, wm) = temp_repo();
        let wt = dir.path().join("wt-a");
        wm.add("agent/a", &wt, None).unwrap();
        let list = wm.list().unwrap();
        assert!(list.iter().any(|w| w.branch == "agent/a"), "{list:?}");
        // file written in the worktree is isolated to that path
        fs::write(wt.join("a.txt"), "hello from agent a").unwrap();
        let status = wm.status(&wt).unwrap();
        assert!(status.contains("a.txt"), "status: {status}");
        // main root does not see it
        assert!(!wm.root.join("a.txt").exists());
    }

    #[test]
    fn two_worktrees_are_independent() {
        let (dir, wm) = temp_repo();
        let wa = dir.path().join("wt-a");
        let wb = dir.path().join("wt-b");
        wm.add("agent/a", &wa, None).unwrap();
        wm.add("agent/b", &wb, None).unwrap();
        fs::write(wa.join("only_a.txt"), "a").unwrap();
        fs::write(wb.join("only_b.txt"), "b").unwrap();
        assert!(wa.join("only_a.txt").exists());
        assert!(!wb.join("only_a.txt").exists());
        assert_eq!(wm.list().unwrap().len(), 3); // main + a + b
    }

    #[test]
    fn remove_worktree() {
        let (dir, wm) = temp_repo();
        let wt = dir.path().join("wt-a");
        wm.add("agent/a", &wt, None).unwrap();
        wm.remove(&wt).unwrap();
        assert!(wm.list().unwrap().iter().all(|w| w.branch != "agent/a"));
    }
}
