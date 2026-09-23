use crate::{
    port::OpenClawGateway,
    surfaces::tasks::{
        Task, TaskCreate, TaskCreateReceipt, TaskManagerOperation, TaskMutationOutcome,
        TaskReadFailure, TaskScope, TaskSnapshot, TaskUpdate, Todo, TodoSnapshot,
    },
};

impl OpenClawGateway {
    /// Lists the task-manager snapshot through the Gateway control exchange.
    pub async fn list_tasks(&mut self, scope: TaskScope) -> Result<TaskSnapshot, TaskReadFailure> {
        self.task_manager(scope)?.list().await
    }

    /// Reads one task through the Gateway control exchange.
    pub async fn get_task(
        &mut self,
        scope: TaskScope,
        task_id: String,
    ) -> Result<Task, TaskReadFailure> {
        self.task_manager(scope)?.get(task_id).await
    }

    /// Creates one task without retrying an ambiguous native mutation.
    pub async fn create_task(
        &mut self,
        scope: TaskScope,
        input: TaskCreate,
    ) -> TaskMutationOutcome<TaskCreateReceipt> {
        match self.task_manager(scope) {
            Ok(operation) => operation.create(input).await,
            Err(_) => TaskMutationOutcome::OutcomeUnknown,
        }
    }

    /// Updates one task without retrying an ambiguous native mutation.
    pub async fn update_task(
        &mut self,
        scope: TaskScope,
        input: TaskUpdate,
    ) -> TaskMutationOutcome<TaskSnapshot> {
        match self.task_manager(scope) {
            Ok(operation) => operation.update(input).await,
            Err(_) => TaskMutationOutcome::OutcomeUnknown,
        }
    }

    /// Replaces the native todo projection without retrying ambiguous delivery.
    pub async fn write_todos(
        &mut self,
        scope: TaskScope,
        old_todos: Vec<Todo>,
        new_todos: Vec<Todo>,
    ) -> TaskMutationOutcome<TodoSnapshot> {
        match self.task_manager(scope) {
            Ok(operation) => operation.todo_write(old_todos, new_todos).await,
            Err(_) => TaskMutationOutcome::OutcomeUnknown,
        }
    }

    /// Reads the native todo projection through the Gateway control exchange.
    pub async fn get_todos(&mut self, scope: TaskScope) -> Result<TodoSnapshot, TaskReadFailure> {
        self.task_manager(scope)?.todo_get().await
    }

    fn task_manager(&mut self, scope: TaskScope) -> Result<TaskManagerOperation, TaskReadFailure> {
        Ok(TaskManagerOperation::new(self.client(), scope))
    }
}
