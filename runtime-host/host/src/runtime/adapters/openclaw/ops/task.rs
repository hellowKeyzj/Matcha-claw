use super::*;

impl TaskOps for OpenClawInstance {
    fn task_manager<'a>(
        &'a self,
        command: crate::tasks::manager::Command,
    ) -> crate::runtime::driver::SessionFuture<'a, crate::tasks::manager::Outcome> {
        Box::pin(async move {
            use crate::tasks::manager::{Command, MutationOutcome, Outcome, ReadOutcome};

            match command {
                Command::List { target } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::List(ReadOutcome::Unavailable),
                    };
                    Outcome::List(self.gateway.lock().await.list_tasks(scope).await.into())
                }
                Command::Get { target, task_id } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::Get(ReadOutcome::Unavailable),
                    };
                    Outcome::Get(
                        self.gateway
                            .lock()
                            .await
                            .get_task(scope, task_id)
                            .await
                            .into(),
                    )
                }
                Command::Create { target, input } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::Create(MutationOutcome::OutcomeUnknown),
                    };
                    Outcome::Create(
                        self.gateway
                            .lock()
                            .await
                            .create_task(scope, input)
                            .await
                            .into(),
                    )
                }
                Command::Update { target, input } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::Update(MutationOutcome::OutcomeUnknown),
                    };
                    Outcome::Update(
                        self.gateway
                            .lock()
                            .await
                            .update_task(scope, input)
                            .await
                            .into(),
                    )
                }
                Command::TodoWrite {
                    target,
                    old_todos,
                    new_todos,
                } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::TodoWrite(MutationOutcome::OutcomeUnknown),
                    };
                    Outcome::TodoWrite(
                        self.gateway
                            .lock()
                            .await
                            .write_todos(scope, old_todos, new_todos)
                            .await
                            .into(),
                    )
                }
                Command::TodoGet { target } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => return Outcome::TodoGet(ReadOutcome::Unavailable),
                    };
                    Outcome::TodoGet(self.gateway.lock().await.get_todos(scope).await.into())
                }
            }
        })
    }
}

fn task_scope<T>(
    open_claw: &OpenClawInstance,
    target: &T,
) -> Result<openclaw::task_manager::TaskScope, ()>
where
    T: TaskScopeTarget,
{
    let workspace = open_claw
        .trusted_workspace_directory(target.session_key())
        .map_err(|_| ())?;
    target.scope(workspace.as_str().to_owned()).map_err(|_| ())
}

trait TaskScopeTarget {
    fn session_key(&self) -> &str;

    fn scope(
        &self,
        workspace_dir: String,
    ) -> Result<openclaw::task_manager::TaskScope, crate::tasks::manager::InvalidIdentity>;
}

impl TaskScopeTarget for crate::tasks::manager::TaskTarget {
    fn session_key(&self) -> &str {
        self.session_key()
    }

    fn scope(
        &self,
        workspace_dir: String,
    ) -> Result<openclaw::task_manager::TaskScope, crate::tasks::manager::InvalidIdentity> {
        self.scope(workspace_dir)
    }
}

impl TaskScopeTarget for crate::tasks::manager::SessionTarget {
    fn session_key(&self) -> &str {
        self.session_key()
    }

    fn scope(
        &self,
        workspace_dir: String,
    ) -> Result<openclaw::task_manager::TaskScope, crate::tasks::manager::InvalidIdentity> {
        self.scope(workspace_dir)
    }
}
