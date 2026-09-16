use super::{CommandInput, CommandOutcome};

pub(super) fn list() -> CommandOutcome {
    crate::capabilities::directory::list()
}

pub(super) fn describe(input: CommandInput) -> CommandOutcome {
    crate::capabilities::directory::describe(input)
}
