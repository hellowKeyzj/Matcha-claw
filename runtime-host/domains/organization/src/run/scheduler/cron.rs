use std::str::FromStr;

use cron::Schedule;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CronScheduleError {
    InvalidExpression,
    InvalidTimestamp,
    NoFutureSlot,
}

pub fn next_cron_slot_after(expression: &str, after: u64) -> Result<u64, CronScheduleError> {
    let schedule = Schedule::from_str(&cron_pattern(expression)?)
        .map_err(|_| CronScheduleError::InvalidExpression)?;
    let after = i64::try_from(after).map_err(|_| CronScheduleError::InvalidTimestamp)?;
    let after =
        chrono::DateTime::from_timestamp(after, 0).ok_or(CronScheduleError::InvalidTimestamp)?;
    let next = schedule
        .after(&after)
        .next()
        .ok_or(CronScheduleError::NoFutureSlot)?;
    u64::try_from(next.timestamp()).map_err(|_| CronScheduleError::InvalidTimestamp)
}

fn cron_pattern(expression: &str) -> Result<String, CronScheduleError> {
    let fields = expression.split_whitespace().collect::<Vec<_>>();
    match fields.len() {
        5 => Ok(format!("0 {} *", fields.join(" "))),
        6 | 7 => Ok(fields.join(" ")),
        _ => Err(CronScheduleError::InvalidExpression),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_the_next_slot_strictly_after_the_current_second() {
        let after = 1_767_225_600;

        assert_eq!(next_cron_slot_after("* * * * *", after), Ok(after + 60));
    }

    #[test]
    fn rejects_invalid_expressions_without_exposing_them() {
        assert_eq!(
            next_cron_slot_after("not a cron", 1_767_225_600),
            Err(CronScheduleError::InvalidExpression)
        );
    }
}
