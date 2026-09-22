use std::fmt;

use crate::{OpenClawConstructionError, parent_callback::ParentCallbackConfigError};
use ::diagnostics::DiagnosticsArchiveError;

use matcha_agent::peer::ConstructionError as MatchaConstructionError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeStartFailure {
    Cancelled,
    CompletionFailed,
    SupervisorStopped,
    Busy,
    Rejected,
    ShuttingDown,
}

impl fmt::Display for RuntimeStartFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Cancelled => "runtime start was cancelled",
            Self::CompletionFailed => "runtime start failed",
            Self::SupervisorStopped => "runtime supervisor stopped during start",
            Self::Busy => "runtime supervisor is busy",
            Self::Rejected => "runtime start was rejected",
            Self::ShuttingDown => "runtime supervisor is shutting down",
        })
    }
}

impl std::error::Error for RuntimeStartFailure {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeLifecycleFailure {
    Cancelled,
    CompletionFailed,
    SupervisorStopped,
    AlreadySatisfied,
    Busy,
    Rejected,
    ShuttingDown,
}

impl fmt::Display for RuntimeLifecycleFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Cancelled => "runtime lifecycle command was cancelled",
            Self::CompletionFailed => "runtime lifecycle command failed",
            Self::SupervisorStopped => "runtime supervisor stopped during lifecycle command",
            Self::AlreadySatisfied => "runtime lifecycle command was already satisfied",
            Self::Busy => "runtime supervisor is busy",
            Self::Rejected => "runtime lifecycle command was rejected",
            Self::ShuttingDown => "runtime supervisor is shutting down",
        })
    }
}

impl std::error::Error for RuntimeLifecycleFailure {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConstructionError {
    Diagnostics(DiagnosticsArchiveError),
    ParentCallback(ParentCallbackConfigError),
    TeamSkillSelection,
    ProviderAccounts,
    ProviderMigration,
    ProviderModels,
    ProviderRouting,
    ExternalConnectors,
    Fleet,
    Settings,
    Security,
    RuntimeState,
    SealedSkills,
    SealedAgents,
    Matcha(MatchaConstructionError),
    OpenClaw(OpenClawConstructionError),
}

impl fmt::Display for ConstructionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Diagnostics(error) => error.fmt(formatter),
            Self::ParentCallback(error) => error.fmt(formatter),
            Self::TeamSkillSelection => {
                formatter.write_str("TeamSkill selection owner could not be constructed")
            }
            Self::ProviderAccounts => {
                formatter.write_str("provider account owner could not be constructed")
            }
            Self::ProviderMigration => {
                formatter.write_str("provider legacy facts could not be migrated")
            }
            Self::ProviderModels => {
                formatter.write_str("provider model owner could not be constructed")
            }
            Self::ProviderRouting => {
                formatter.write_str("provider routing owner could not be constructed")
            }
            Self::ExternalConnectors => {
                formatter.write_str("external connector owner could not be constructed")
            }
            Self::Fleet => formatter.write_str("Fleet owner could not be constructed"),
            Self::Settings => formatter.write_str("settings owner could not be constructed"),
            Self::Security => formatter.write_str("security owner could not be constructed"),
            Self::RuntimeState => {
                formatter.write_str("runtime state directory could not be provisioned")
            }
            Self::SealedSkills => {
                formatter.write_str("sealed skill store could not be constructed")
            }
            Self::SealedAgents => {
                formatter.write_str("sealed agent store could not be constructed")
            }
            Self::Matcha(error) => error.fmt(formatter),
            Self::OpenClaw(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for ConstructionError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Diagnostics(error) => Some(error),
            Self::ParentCallback(error) => Some(error),
            Self::TeamSkillSelection
            | Self::ProviderAccounts
            | Self::ProviderMigration
            | Self::ProviderModels
            | Self::ProviderRouting
            | Self::ExternalConnectors
            | Self::Fleet
            | Self::Settings
            | Self::Security
            | Self::RuntimeState
            | Self::SealedSkills
            | Self::SealedAgents => None,
            Self::Matcha(error) => Some(error),
            Self::OpenClaw(error) => Some(error),
        }
    }
}
