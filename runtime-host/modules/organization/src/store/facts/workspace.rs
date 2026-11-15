use super::*;
use std::{fs, path::Path};
use sha2::{Digest, Sha256};
use crate::{RunWorkspace, StoreFault};

impl OrganizationFacts {
    // Called under the same SQLite writer transaction as the new RunHeader.
    pub(in crate::store) fn initialize_run_workspaces(&mut self, root: &Path) -> Result<(), StoreFault> {
        let inserted = self.journal.runs.iter().filter_map(|(id, undo)| {
            matches!(undo, transaction::RunUndo::Inserted).then_some(id.clone())
        }).collect::<Vec<_>>();
        if inserted.is_empty() { return Ok(()); }
        crate::store::content::check_directory(root, false).map_err(|error| StoreFault::Read(error.kind()))?;
        let root = platform::state_dir::CanonicalStateDir::open_existing(root)
            .map_err(|_| StoreFault::Read(std::io::ErrorKind::InvalidData))?.as_path().to_owned();
        for id in inserted {
            let run = self.runs.get(&id).ok_or(StoreFault::InvalidFacts)?;
            if run.workspace().is_some() { continue; }
            let team_id = run.team().clone();
            let team = self.teams.get(team_id.as_str()).ok_or(StoreFault::InvalidFacts)?;
            let name = if let Some(name) = team.workspace_directory_name() {
                name.to_owned()
            } else {
                let base = crate::run::workspace::directory_name(team.definition().name());
                let mut taken = self.teams.values().filter_map(TeamFacts::workspace_directory_name)
                    .map(str::to_lowercase).collect::<BTreeSet<_>>();
                let parent = root.join("workspaces");
                match fs::symlink_metadata(&parent) {
                    Ok(_) => {
                        crate::store::content::check_directory(&parent, false).map_err(|error| StoreFault::Read(error.kind()))?;
                        for entry in fs::read_dir(&parent).map_err(|error| StoreFault::Read(error.kind()))? {
                            let entry = entry.map_err(|error| StoreFault::Read(error.kind()))?;
                            taken.insert(entry.file_name().to_string_lossy().to_lowercase());
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(StoreFault::Read(error.kind())),
                }
                let mut name = base.clone();
                let mut suffix = 2u64;
                while taken.contains(&name.to_lowercase()) {
                    name = format!("{base}-{suffix}");
                    suffix = suffix.checked_add(1).ok_or(StoreFault::InvalidFacts)?;
                }
                self.touch_team(team_id.as_str());
                self.teams.get_mut(team_id.as_str()).expect("validated team").workspace_directory_name = Some(name.clone());
                name
            };
            let directory = root.join("workspaces").join(name)
                .join(format!("{:x}", Sha256::digest(id.as_bytes())));
            match fs::symlink_metadata(&directory) {
                Ok(_) => return Err(StoreFault::Commit(std::io::ErrorKind::AlreadyExists)),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(StoreFault::Read(error.kind())),
            }
            let workspace = RunWorkspace::try_new(directory, false).map_err(|_| StoreFault::InvalidFacts)?;
            let run = self.runs.get(&id).expect("inserted run");
            let receipt = run.initial_runtime_receipt(self.materialization(&team_id).ok_or(StoreFault::InvalidFacts)?)
                .map_err(|_| StoreFault::InvalidFacts)?;
            let run = self.runs.get_mut(&id).expect("inserted run");
            run.workspace = Some(workspace);
            for (ordinal, binding) in receipt.bindings().iter().enumerate() {
                run.role_session_intents.insert(format!("initial:{ordinal:020}"), RoleSessionIntent {
                    binding: binding.clone(), phase: RoleSessionPhase::Reserved,
                });
            }
        }
        Ok(())
    }

    pub(in crate::store) fn validate_terminal_files(
        &self, target: &crate::store::NativeTerminalReceiptTarget, output: &crate::TeamNodeOutput,
        validation: Option<&(crate::run::workspace::RunFileValidationPlan, Result<(), crate::RunFileValidationError>)>,
    ) -> Result<(), crate::application::team_message::TeamMessageFailure> {
        use crate::application::team_message::TeamMessageFailure::{FileUnavailable, InvalidFiles};
        if output.files().is_empty() { return Ok(()); }
        let run = self.run(target.graph_run_id()).ok_or(FileUnavailable)?;
        let Some(workspace) = run.workspace() else { return Err(InvalidFiles); };
        let delivery = self.deliveries().delivery(target.delivery_id()).ok_or(FileUnavailable)?;
        let binding = run.runtime().and_then(|runtime| runtime.bindings().iter().find(|binding| {
            binding.endpoint_session_id() == target.correlation().endpoint_session_id()
                && binding.team() == run.team() && binding.team_run() == run.run_id()
                && binding.role().as_str() == delivery.facts().role_id
                && binding.session_ref().as_str() == delivery.facts().session_ref
        })).ok_or(FileUnavailable)?;
        let (plan, result) = validation.ok_or(FileUnavailable)?;
        if !run.workspace_ready() || plan.binding != *binding || plan.workspace != *workspace || plan.paths != output.files() {
            return Err(FileUnavailable);
        }
        result.map_err(|error| match error {
            crate::RunFileValidationError::InvalidPath | crate::RunFileValidationError::MissingFile => InvalidFiles,
            crate::RunFileValidationError::Unavailable => FileUnavailable,
        })
    }

    pub(super) fn validate_workspace(&self, run: &GraphRunFacts) -> Result<(), OrganizationFactsError> {
        let team = self.team(run.team()).ok_or(OrganizationFactsError::UnknownRunTeam)?;
        Self::validate_run_workspace(run, team)
    }

    pub(super) fn validate_run_workspace(run: &GraphRunFacts, team: &TeamFacts) -> Result<(), OrganizationFactsError> {
        let Some(workspace) = run.workspace() else { return Ok(()); };
        let name = team.workspace_directory_name().ok_or(OrganizationFactsError::InvalidGraphRun)?;
        let path = workspace.root();
        if path.file_name().and_then(|name| name.to_str()) != Some(format!("{:x}", Sha256::digest(run.run_id().as_str().as_bytes())).as_str())
            || path.parent().and_then(Path::file_name).and_then(|name| name.to_str()) != Some(name)
            || path.parent().and_then(Path::parent).and_then(Path::file_name).and_then(|name| name.to_str()) != Some("workspaces")
            || (run.runtime().is_some() && !workspace.is_prepared())
        {
            return Err(OrganizationFactsError::InvalidGraphRun);
        }
        Ok(())
    }
}

impl crate::OrganizationStore {
    pub(crate) fn prepare_run_workspace(&mut self, run_id: &GraphRunId) -> Result<Option<RunWorkspace>, StoreFault> {
        self.refresh()?;
        let run = self.facts().run(run_id).ok_or(StoreFault::InvalidFacts)?;
        let Some(mut workspace) = run.workspace().cloned() else { return Ok(None); };
        let root = self.path().parent().ok_or(StoreFault::InvalidFacts)?;
        crate::store::content::check_directory(root, false).map_err(|error| StoreFault::Read(error.kind()))?;
        let root = platform::state_dir::CanonicalStateDir::open_existing(root)
            .map_err(|_| StoreFault::Read(std::io::ErrorKind::InvalidData))?.as_path().to_owned();
        let team = self.facts().team(run.team()).ok_or(StoreFault::InvalidFacts)?;
        let team_directory = root.join("workspaces").join(team.workspace_directory_name().ok_or(StoreFault::InvalidFacts)?);
        let expected = team_directory.join(format!("{:x}", Sha256::digest(run_id.as_str().as_bytes())));
        if expected != workspace.root() { return Err(StoreFault::InvalidFacts); }
        let used = self.facts().runs().any(|other| other.team() == run.team()
            && other.workspace().is_some_and(RunWorkspace::is_prepared));
        for (directory, create) in [
            (root.join("workspaces"), !used && !workspace.is_prepared()),
            (team_directory, !used && !workspace.is_prepared()),
            (expected, !workspace.is_prepared()),
        ] {
            crate::store::content::check_directory(&directory, create).map_err(|error| StoreFault::Commit(error.kind()))?;
        }
        if !workspace.is_prepared() {
            let original = workspace.clone();
            self.transact(|facts| {
                let run = facts.run(run_id).ok_or(StoreFault::InvalidFacts)?;
                if run.workspace() != Some(&original) || !matches!(run.lifecycle().state(), GraphRunLifecycleState::Active)
                    || facts.team(run.team()).is_none_or(|team| team.tombstoned()) { return Err(StoreFault::InvalidFacts); }
                facts.touch_run(run_id.as_str());
                facts.runs.get_mut(run_id.as_str()).expect("validated run").workspace.as_mut().expect("validated workspace").mark_prepared();
                Ok(())
            })?;
            workspace.mark_prepared();
        }
        Ok(Some(workspace))
    }
}
