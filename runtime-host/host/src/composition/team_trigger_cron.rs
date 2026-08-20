use std::collections::BTreeMap;

use organization::{
    ArmedCronTrigger, CronScheduleError, CronTriggerScheduleError, DueCronTriggerPlan,
    TriggerFireRequest, next_cron_slot_after, plan_due_cron_trigger,
};

use super::{ArmedTrigger, TeamTrigger};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum CronReconciliation {
    AwaitingSlot,
    Due(DueCronTriggerPlan),
    InvalidSchedule,
    OutcomeUnknown,
}

#[derive(Default)]
pub(crate) struct TeamTriggerCron {
    slots: BTreeMap<(String, String), u64>,
}

impl TeamTriggerCron {
    pub(crate) fn reconcile(
        &mut self,
        triggers: Vec<ArmedTrigger>,
        now: u64,
    ) -> Vec<CronReconciliation> {
        let mut armed = BTreeMap::new();
        let mut reconciliations = Vec::new();

        for trigger in triggers {
            let TeamTrigger::Cron { expression } = trigger.trigger else {
                continue;
            };
            let key = (trigger.run_id.as_str().to_owned(), trigger.start_node_id);
            let next_slot_at = match self.slots.get(&key).copied() {
                Some(slot) => slot,
                None => match next_cron_slot_after(&expression, now) {
                    Ok(slot) => slot,
                    Err(CronScheduleError::InvalidExpression | CronScheduleError::NoFutureSlot) => {
                        reconciliations.push(CronReconciliation::InvalidSchedule);
                        continue;
                    }
                    Err(CronScheduleError::InvalidTimestamp) => {
                        reconciliations.push(CronReconciliation::OutcomeUnknown);
                        continue;
                    }
                },
            };
            armed.insert(key.clone(), (expression, next_slot_at));
        }

        self.slots.retain(|key, _| armed.contains_key(key));
        for (key, (expression, next_slot_at)) in armed {
            let successor = if next_slot_at <= now {
                match next_cron_slot_after(&expression, now) {
                    Ok(slot) => Some(slot),
                    Err(CronScheduleError::NoFutureSlot) => None,
                    Err(CronScheduleError::InvalidExpression) => {
                        reconciliations.push(CronReconciliation::InvalidSchedule);
                        continue;
                    }
                    Err(CronScheduleError::InvalidTimestamp) => {
                        reconciliations.push(CronReconciliation::OutcomeUnknown);
                        continue;
                    }
                }
            } else {
                None
            };
            let plan = plan_due_cron_trigger(
                ArmedCronTrigger {
                    run_id: key.0.clone(),
                    start_node_id: key.1.clone(),
                    next_slot_at,
                },
                now,
                successor,
            );
            match plan {
                Ok(Some(plan)) => {
                    match plan.next_slot_at {
                        Some(slot) => {
                            self.slots.insert(key, slot);
                        }
                        None => {
                            self.slots.remove(&key);
                        }
                    }
                    reconciliations.push(CronReconciliation::Due(plan));
                }
                Ok(None) => {
                    self.slots.insert(key, next_slot_at);
                    reconciliations.push(CronReconciliation::AwaitingSlot);
                }
                Err(CronTriggerScheduleError::InvalidTrigger(_)) => {
                    reconciliations.push(CronReconciliation::InvalidSchedule);
                }
                Err(CronTriggerScheduleError::NonAdvancingNextSlot) => {
                    reconciliations.push(CronReconciliation::OutcomeUnknown);
                }
            }
        }
        reconciliations
    }

    pub(crate) fn unknown(&mut self, request: &TriggerFireRequest) {
        self.slots
            .remove(&(request.run_id.clone(), request.start_node_id.clone()));
    }
}

#[cfg(test)]
mod tests {
    use organization::{GraphRunId, TeamId};

    use super::*;

    fn armed(expression: &str) -> ArmedTrigger {
        ArmedTrigger {
            team_id: TeamId::try_new("team-1").unwrap(),
            run_id: GraphRunId::new("run-1"),
            start_node_id: "start-1".into(),
            trigger: TeamTrigger::Cron {
                expression: expression.into(),
            },
        }
    }

    #[test]
    fn advances_before_emitting_the_due_slot_and_does_not_replay_it() {
        let mut cron = TeamTriggerCron::default();
        let now = 1_767_225_600;
        assert_eq!(
            cron.reconcile(vec![armed("* * * * *")], now),
            vec![CronReconciliation::AwaitingSlot]
        );
        let due = cron.reconcile(vec![armed("* * * * *")], now + 60);
        let [CronReconciliation::Due(plan)] = due.as_slice() else {
            panic!("due slot expected");
        };
        assert_eq!(
            plan.fire.idempotency_key,
            "team-cron:run-1:start-1:1767225660"
        );
        assert_eq!(plan.next_slot_at, Some(now + 120));
        assert_eq!(
            cron.reconcile(vec![armed("* * * * *")], now + 60),
            vec![CronReconciliation::AwaitingSlot]
        );
    }

    #[test]
    fn marks_invalid_schedule_without_emitting_a_trigger() {
        assert_eq!(
            TeamTriggerCron::default().reconcile(vec![armed("not a cron")], 1_767_225_600),
            vec![CronReconciliation::InvalidSchedule]
        );
    }

    #[test]
    fn forgetting_an_unknown_outcome_prevents_a_replay() {
        let mut cron = TeamTriggerCron::default();
        let now = 1_767_225_600;
        cron.reconcile(vec![armed("* * * * *")], now);
        let due = cron.reconcile(vec![armed("* * * * *")], now + 60);
        let [CronReconciliation::Due(plan)] = due.as_slice() else {
            panic!("due slot expected");
        };
        cron.unknown(&plan.fire);

        assert_eq!(
            cron.reconcile(vec![armed("* * * * *")], now + 60),
            vec![CronReconciliation::AwaitingSlot]
        );
    }
}
