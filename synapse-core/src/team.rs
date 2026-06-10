//! Team composition. A team is just a list of `(role, count)` specs; expanding it
//! produces uniquely-named agent specs the orchestrator spawns. The whole point:
//! arbitrary team size/shape with zero special-casing.

use crate::roles::{Preset, RoleLibrary};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberSpec {
    pub role: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub name: String,
    pub members: Vec<TeamMemberSpec>,
}

/// One concrete agent to spawn: a role plus its unique name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSlot {
    pub role_id: String,
    pub name: String,
}

impl Team {
    pub fn new(name: &str) -> Self {
        Team {
            name: name.to_string(),
            members: Vec::new(),
        }
    }

    pub fn with(mut self, role: &str, count: u32) -> Self {
        self.members.push(TeamMemberSpec {
            role: role.to_string(),
            count,
        });
        self
    }

    /// Build a team from a named preset in the library.
    pub fn from_preset(preset: &Preset) -> Self {
        Team {
            name: preset.label.clone(),
            members: preset
                .members
                .iter()
                .map(|(role, count)| TeamMemberSpec {
                    role: role.clone(),
                    count: *count,
                })
                .collect(),
        }
    }

    /// Total number of agents this team will spawn.
    pub fn agent_count(&self) -> u32 {
        self.members.iter().map(|m| m.count).sum()
    }

    /// Expand into concrete, uniquely-named agent slots (e.g. backend-dev-1,
    /// backend-dev-2). When a role has a single instance it keeps its bare id.
    pub fn expand(&self) -> Vec<AgentSlot> {
        let mut out = Vec::new();
        for m in &self.members {
            if m.count == 1 {
                out.push(AgentSlot {
                    role_id: m.role.clone(),
                    name: m.role.clone(),
                });
            } else {
                for i in 1..=m.count {
                    out.push(AgentSlot {
                        role_id: m.role.clone(),
                        name: format!("{}-{}", m.role, i),
                    });
                }
            }
        }
        out
    }

    /// Validate that every referenced role exists. Returns the list of unknown
    /// role ids (empty = valid).
    pub fn validate(&self, lib: &RoleLibrary) -> Vec<String> {
        self.members
            .iter()
            .filter(|m| lib.get(&m.role).is_none())
            .map(|m| m.role.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expand_names_are_unique_and_indexed() {
        let team = Team::new("t")
            .with("backend-dev", 2)
            .with("code-reviewer", 1);
        let slots = team.expand();
        let names: Vec<_> = slots.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(names, vec!["backend-dev-1", "backend-dev-2", "code-reviewer"]);
        assert_eq!(team.agent_count(), 3);
    }

    #[test]
    fn arbitrary_sizes_just_work() {
        // 3 devs, then 5 devs — same code path, only the number changes.
        let three = Team::new("t").with("frontend-dev", 3);
        assert_eq!(three.expand().len(), 3);
        let five = Team::new("t").with("frontend-dev", 5).with("security-reviewer", 1);
        assert_eq!(five.expand().len(), 6);
    }

    #[test]
    fn from_preset_round_trips() {
        let lib = RoleLibrary::builtin_default();
        let preset = lib.preset("full-squad").unwrap();
        let team = Team::from_preset(preset);
        assert!(team.validate(&lib).is_empty());
        assert_eq!(team.agent_count(), 2 + 3 + 1 + 1 + 1);
    }

    #[test]
    fn validate_flags_unknown_roles() {
        let lib = RoleLibrary::builtin_default();
        let team = Team::new("t").with("nonexistent-role", 1);
        assert_eq!(team.validate(&lib), vec!["nonexistent-role".to_string()]);
    }
}
