use super::*;
use workspace_module::WorkspaceOps;

impl ::task_manager::TaskOps for OpenClawDriver {
    fn task_manager<'a>(
        &'a self,
        command: ::task_manager::TaskCommand,
    ) -> ::task_manager::TaskFuture<'a, ::task_manager::TaskOutcome> {
        Box::pin(async move {
            match command {
                ::task_manager::TaskCommand::List { target } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => {
                            return ::task_manager::TaskOutcome::List(
                                ::task_manager::TaskReadOutcome::Unavailable,
                            );
                        }
                    };
                    ::task_manager::TaskOutcome::List(project_read(
                        self.gateway.lock().await.list_tasks(scope).await,
                        project_snapshot,
                    ))
                }
                ::task_manager::TaskCommand::Get { target, task_id } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => {
                            return ::task_manager::TaskOutcome::Get(
                                ::task_manager::TaskReadOutcome::Unavailable,
                            );
                        }
                    };
                    ::task_manager::TaskOutcome::Get(project_read(
                        self.gateway.lock().await.get_task(scope, task_id).await,
                        |task| project_task(&task),
                    ))
                }
                ::task_manager::TaskCommand::Create { target, input } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => {
                            return ::task_manager::TaskOutcome::Create(
                                ::task_manager::TaskMutationOutcome::OutcomeUnknown,
                            );
                        }
                    };
                    let input = match project_create(input) {
                        Ok(input) => input,
                        Err(()) => {
                            return ::task_manager::TaskOutcome::Create(
                                ::task_manager::TaskMutationOutcome::OutcomeUnknown,
                            );
                        }
                    };
                    ::task_manager::TaskOutcome::Create(project_mutation(
                        self.gateway.lock().await.create_task(scope, input).await,
                        project_create_receipt,
                    ))
                }
                ::task_manager::TaskCommand::Update { target, input } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => {
                            return ::task_manager::TaskOutcome::Update(
                                ::task_manager::TaskMutationOutcome::OutcomeUnknown,
                            );
                        }
                    };
                    let input = match project_update(input) {
                        Ok(input) => input,
                        Err(()) => {
                            return ::task_manager::TaskOutcome::Update(
                                ::task_manager::TaskMutationOutcome::OutcomeUnknown,
                            );
                        }
                    };
                    ::task_manager::TaskOutcome::Update(project_mutation(
                        self.gateway.lock().await.update_task(scope, input).await,
                        project_snapshot,
                    ))
                }
                ::task_manager::TaskCommand::TodoWrite {
                    target,
                    old_todos,
                    new_todos,
                } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => {
                            return ::task_manager::TaskOutcome::TodoWrite(
                                ::task_manager::TaskMutationOutcome::OutcomeUnknown,
                            );
                        }
                    };
                    let old_todos = match project_todo_input_list(old_todos) {
                        Ok(todos) => todos,
                        Err(()) => {
                            return ::task_manager::TaskOutcome::TodoWrite(
                                ::task_manager::TaskMutationOutcome::OutcomeUnknown,
                            );
                        }
                    };
                    let new_todos = match project_todo_input_list(new_todos) {
                        Ok(todos) => todos,
                        Err(()) => {
                            return ::task_manager::TaskOutcome::TodoWrite(
                                ::task_manager::TaskMutationOutcome::OutcomeUnknown,
                            );
                        }
                    };
                    ::task_manager::TaskOutcome::TodoWrite(project_mutation(
                        self.gateway
                            .lock()
                            .await
                            .write_todos(scope, old_todos, new_todos)
                            .await,
                        project_todo_snapshot,
                    ))
                }
                ::task_manager::TaskCommand::TodoGet { target } => {
                    let scope = match task_scope(self, &target) {
                        Ok(scope) => scope,
                        Err(()) => {
                            return ::task_manager::TaskOutcome::TodoGet(
                                ::task_manager::TaskReadOutcome::Unavailable,
                            );
                        }
                    };
                    ::task_manager::TaskOutcome::TodoGet(project_read(
                        self.gateway.lock().await.get_todos(scope).await,
                        project_todo_snapshot,
                    ))
                }
            }
        })
    }

    fn task_runtime_ready(&self) -> bool {
        self.owner().snapshot().phase() == SupervisorPhase::Running
    }
}

fn task_scope<T>(
    open_claw: &OpenClawDriver,
    target: &T,
) -> Result<crate::task_manager::TaskScope, ()>
where
    T: TaskScopeTarget,
{
    let workspace = open_claw
        .trusted_workspace_directory(target.session_key())
        .map_err(|_| ())?;
    crate::task_manager::TaskScope::try_new(
        target.session_key().to_owned(),
        target.team_key().map(str::to_owned),
        workspace.as_str().to_owned(),
    )
    .map_err(|_| ())
}

trait TaskScopeTarget {
    fn session_key(&self) -> &str;

    fn team_key(&self) -> Option<&str> {
        None
    }
}

impl TaskScopeTarget for ::task_manager::TaskTarget {
    fn session_key(&self) -> &str {
        self.session_key()
    }

    fn team_key(&self) -> Option<&str> {
        self.team_key()
    }
}

impl TaskScopeTarget for ::task_manager::SessionTarget {
    fn session_key(&self) -> &str {
        self.session_key()
    }
}

fn project_create(
    input: ::task_manager::TaskCreate,
) -> Result<crate::task_manager::TaskCreate, ()> {
    crate::task_manager::TaskCreate::try_new(
        input.subject().to_owned(),
        input.description().to_owned(),
        input.active_form().map(str::to_owned),
        input.owner().map(str::to_owned),
        input.metadata().map(project_metadata),
    )
    .map_err(|_| ())
}

fn project_update(
    input: ::task_manager::TaskUpdate,
) -> Result<crate::task_manager::TaskUpdate, ()> {
    crate::task_manager::TaskUpdate::try_new(
        input.task_id().to_owned(),
        input.status().map(project_task_status),
        input.subject().map(str::to_owned),
        input.description().map(str::to_owned),
        input.active_form().map(str::to_owned),
        input.owner().map(str::to_owned),
        input.add_blocked_by().map(<[String]>::to_vec),
        input.add_blocks().map(<[String]>::to_vec),
        input.metadata().map(project_metadata),
    )
    .map_err(|_| ())
}

fn project_todo_input_list(
    values: Vec<::task_manager::Todo>,
) -> Result<Vec<crate::task_manager::Todo>, ()> {
    values.into_iter().map(project_todo_input).collect()
}

fn project_todo_input(value: ::task_manager::Todo) -> Result<crate::task_manager::Todo, ()> {
    crate::task_manager::Todo::try_new(
        value.id().map(str::to_owned),
        value.content().to_owned(),
        value.active_form().map(str::to_owned),
        project_todo_status(value.status()),
        value.owner().map(str::to_owned),
    )
    .map_err(|_| ())
}

fn project_metadata(value: &::task_manager::TaskMetadata) -> crate::task_manager::TaskMetadata {
    crate::task_manager::TaskMetadata::new(value.as_object().clone())
}

fn project_read<T, U>(
    result: Result<T, crate::task_manager::TaskReadFailure>,
    project: impl FnOnce(T) -> U,
) -> ::task_manager::TaskReadOutcome<U> {
    match result {
        Ok(value) => ::task_manager::TaskReadOutcome::Found(project(value)),
        Err(crate::task_manager::TaskReadFailure::NotFound) => {
            ::task_manager::TaskReadOutcome::NotFound
        }
        Err(crate::task_manager::TaskReadFailure::Unavailable) => {
            ::task_manager::TaskReadOutcome::Unavailable
        }
        Err(crate::task_manager::TaskReadFailure::Rejected) => {
            ::task_manager::TaskReadOutcome::Rejected
        }
        Err(crate::task_manager::TaskReadFailure::Protocol) => {
            ::task_manager::TaskReadOutcome::Protocol
        }
    }
}

fn project_mutation<T, U>(
    outcome: crate::task_manager::TaskMutationOutcome<T>,
    project: impl FnOnce(T) -> U,
) -> ::task_manager::TaskMutationOutcome<U> {
    match outcome {
        crate::task_manager::TaskMutationOutcome::Applied(value) => {
            ::task_manager::TaskMutationOutcome::Applied(project(value))
        }
        crate::task_manager::TaskMutationOutcome::Rejected => {
            ::task_manager::TaskMutationOutcome::Rejected
        }
        crate::task_manager::TaskMutationOutcome::OutcomeUnknown => {
            ::task_manager::TaskMutationOutcome::OutcomeUnknown
        }
    }
}

fn project_create_receipt(
    receipt: crate::task_manager::TaskCreateReceipt,
) -> ::task_manager::TaskCreateReceipt {
    ::task_manager::TaskCreateReceipt::new(
        project_task(receipt.task()),
        project_snapshot(receipt.snapshot().clone()),
    )
}

fn project_snapshot(snapshot: crate::task_manager::TaskSnapshot) -> ::task_manager::TaskSnapshot {
    ::task_manager::TaskSnapshot::new(
        snapshot.tasks().iter().map(project_task).collect(),
        snapshot.todos().iter().map(project_todo).collect(),
    )
}

fn project_todo_snapshot(
    snapshot: crate::task_manager::TodoSnapshot,
) -> ::task_manager::TodoSnapshot {
    ::task_manager::TodoSnapshot::new(
        snapshot.todos().iter().map(project_todo).collect(),
        snapshot.updated_at(),
    )
}

fn project_task(task: &crate::task_manager::Task) -> ::task_manager::Task {
    ::task_manager::Task::new(
        task.id().to_owned(),
        task.subject().to_owned(),
        task.description().to_owned(),
        task.active_form().map(str::to_owned),
        project_task_status_from_openclaw(task.status()),
        task.owner().map(str::to_owned),
        task.blocked_by().to_vec(),
        task.blocks().to_vec(),
        task.metadata()
            .map(|metadata| ::task_manager::TaskMetadata::new(metadata.as_object().clone())),
        task.created_at(),
        task.updated_at(),
    )
}

fn project_todo(todo: &crate::task_manager::Todo) -> ::task_manager::Todo {
    ::task_manager::Todo::try_new(
        todo.id().map(str::to_owned),
        todo.content().to_owned(),
        todo.active_form().map(str::to_owned),
        project_todo_status_from_openclaw(todo.status()),
        todo.owner().map(str::to_owned),
    )
    .expect("OpenClaw todo already passed native validation")
}

fn project_task_status(status: ::task_manager::TaskStatus) -> crate::task_manager::TaskStatus {
    match status {
        ::task_manager::TaskStatus::Pending => crate::task_manager::TaskStatus::Pending,
        ::task_manager::TaskStatus::InProgress => crate::task_manager::TaskStatus::InProgress,
        ::task_manager::TaskStatus::Completed => crate::task_manager::TaskStatus::Completed,
        ::task_manager::TaskStatus::Deleted => crate::task_manager::TaskStatus::Deleted,
    }
}

fn project_task_status_from_openclaw(
    status: crate::task_manager::TaskStatus,
) -> ::task_manager::TaskStatus {
    match status {
        crate::task_manager::TaskStatus::Pending => ::task_manager::TaskStatus::Pending,
        crate::task_manager::TaskStatus::InProgress => ::task_manager::TaskStatus::InProgress,
        crate::task_manager::TaskStatus::Completed => ::task_manager::TaskStatus::Completed,
        crate::task_manager::TaskStatus::Deleted => ::task_manager::TaskStatus::Deleted,
    }
}

fn project_todo_status(status: ::task_manager::TodoStatus) -> crate::task_manager::TodoStatus {
    match status {
        ::task_manager::TodoStatus::Pending => crate::task_manager::TodoStatus::Pending,
        ::task_manager::TodoStatus::InProgress => crate::task_manager::TodoStatus::InProgress,
        ::task_manager::TodoStatus::Completed => crate::task_manager::TodoStatus::Completed,
    }
}

fn project_todo_status_from_openclaw(
    status: crate::task_manager::TodoStatus,
) -> ::task_manager::TodoStatus {
    match status {
        crate::task_manager::TodoStatus::Pending => ::task_manager::TodoStatus::Pending,
        crate::task_manager::TodoStatus::InProgress => ::task_manager::TodoStatus::InProgress,
        crate::task_manager::TodoStatus::Completed => ::task_manager::TodoStatus::Completed,
    }
}
