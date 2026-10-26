use super::{Error, Measurements, accounting, numeric, run::AcceptedResult};
use std::{cmp::Ordering, collections::BTreeMap};
use world_protocol::{
    evaluation::{
        AcceptanceCriterion, ArmMetrics, CandidateVerdict, CaseExecution, EffectEstimate,
        EvaluationArm, EvaluationAssurance, EvaluationFailure, EvaluationMetric, EvaluationReport,
        FrozenSuite, Replayability,
    },
    ids::CaseId,
    learning::{CaseOriginKind, DatasetSplit, TestCase},
    time::DurationMs,
};

fn origin(
    result: &AcceptedResult,
    origins: &BTreeMap<CaseId, CaseOriginKind>,
) -> Option<CaseOriginKind> {
    result
        .case
        .as_ref()
        .and_then(|case| origins.get(&case.id).copied())
}

fn measured_sum(
    selected: &[&AcceptedResult],
    value: impl Fn(&Measurements) -> Option<u64>,
) -> Result<Option<u64>, Error> {
    let mut total = 0u64;
    for result in selected {
        let Some(value) = result.measurements.as_ref().and_then(&value) else {
            return Ok(None);
        };
        total = total
            .checked_add(value)
            .ok_or(EvaluationFailure::InternalFault)?;
    }
    Ok(Some(total))
}

fn measured_rate(
    numerator: Option<u64>,
    denominator: Option<u64>,
) -> Option<world_protocol::value::Decimal> {
    numeric::ratio(numerator?, denominator?)
}

pub(super) fn summarize(
    report: &mut EvaluationReport,
    suite: &FrozenSuite,
    tests: &[TestCase],
    results: &[AcceptedResult],
    origins: &BTreeMap<CaseId, CaseOriginKind>,
    replayability: Replayability,
) -> Result<(), Error> {
    report.coverage.missing_tests = suite
        .tests
        .iter()
        .filter(|test| {
            suite.arms.iter().any(|arm| {
                !results.iter().any(|result| {
                    result.evaluation.test == **test
                        && result.evaluation.arm == *arm
                        && result.evaluation.oracle_passed.is_some()
                        && matches!(
                            result.evaluation.execution,
                            CaseExecution::Completed | CaseExecution::BusinessFailed { .. }
                        )
                })
            })
        })
        .cloned()
        .collect();
    report.coverage.tested = report
        .coverage
        .total
        .checked_sub(report.coverage.missing_tests.len() as u64)
        .ok_or(EvaluationFailure::InternalFault)?;
    report.assurance = if results
        .iter()
        .any(|result| result.evaluation.oracle_passed.is_some())
    {
        EvaluationAssurance::Tested
    } else {
        EvaluationAssurance::Untested
    };
    report.counterexamples = results
        .iter()
        .filter(|result| {
            result.evaluation.arm == EvaluationArm::Candidate
                && result.evaluation.oracle_passed == Some(false)
        })
        .map(|result| result.evaluation.test.clone())
        .collect();
    report.arms.clear();
    report.estimates.clear();
    for arm in &suite.arms {
        for split in [
            DatasetSplit::Train,
            DatasetSplit::Dev,
            DatasetSplit::Holdout,
        ] {
            for kind in [
                CaseOriginKind::Recorded,
                CaseOriginKind::Replay,
                CaseOriginKind::Synthetic,
                CaseOriginKind::Fixture,
            ] {
                let selected: Vec<_> = results
                    .iter()
                    .filter(|result| {
                        result.evaluation.arm == *arm
                            && origin(result, origins) == Some(kind)
                            && tests.iter().any(|test| {
                                test.id == result.evaluation.test.id
                                    && test.revision == result.evaluation.test.revision
                                    && test.split == split
                            })
                    })
                    .collect();
                let sample_size = selected
                    .iter()
                    .filter(|result| result.evaluation.oracle_passed.is_some())
                    .count() as u64;
                let Some(success) = numeric::ratio(
                    selected
                        .iter()
                        .filter(|result| result.evaluation.oracle_passed == Some(true))
                        .count() as u64,
                    sample_size,
                ) else {
                    continue;
                };
                let mut usage = accounting::zero();
                for result in &selected {
                    accounting::add(&mut usage, &result.evaluation.usage)?;
                }
                let dangerous_effects = measured_sum(&selected, |value| value.dangerous_effects)?;
                let error_merge = measured_rate(
                    measured_sum(&selected, |value| value.error_merges)?,
                    measured_sum(&selected, |value| value.identity_decisions)?,
                );
                let evidence_coverage = measured_rate(
                    measured_sum(&selected, |value| value.evidence_satisfied)?,
                    measured_sum(&selected, |value| value.evidence_required)?,
                );
                let conflict = measured_rate(
                    measured_sum(&selected, |value| value.conflicts_detected)?,
                    measured_sum(&selected, |value| value.conflicts_present)?,
                );
                let active_complexity = selected
                    .iter()
                    .map(|result| result.measurements.as_ref()?.active_complexity)
                    .collect::<Option<Vec<_>>>()
                    .and_then(|values| values.into_iter().max());
                let retraction_lag = selected
                    .iter()
                    .map(|result| result.measurements.as_ref()?.retraction_lag)
                    .collect::<Option<Vec<_>>>()
                    .and_then(|values| values.into_iter().max());
                let migration_cost = if let Some(values) = selected
                    .iter()
                    .map(|result| result.measurements.as_ref()?.migration_cost.as_ref())
                    .collect::<Option<Vec<_>>>()
                {
                    let mut total = numeric::integer(0);
                    for value in values {
                        total =
                            numeric::add(&total, value).ok_or(EvaluationFailure::InternalFault)?;
                    }
                    Some(total)
                } else {
                    None
                };
                let mut regressions = 0u64;
                let mut comparisons = 0u64;
                if *arm == EvaluationArm::Candidate {
                    for result in &selected {
                        if result.evaluation.oracle_passed.is_none() {
                            continue;
                        }
                        for baseline in [
                            EvaluationArm::ToolMemory,
                            EvaluationArm::StaticOntology,
                            EvaluationArm::AppendOnly,
                        ] {
                            if results.iter().any(|other| {
                                other.evaluation.arm == baseline
                                    && other.evaluation.test == result.evaluation.test
                                    && origin(other, origins) == Some(kind)
                                    && other.evaluation.oracle_passed == Some(true)
                            }) {
                                comparisons = comparisons
                                    .checked_add(1)
                                    .ok_or(EvaluationFailure::InternalFault)?;
                                if result.evaluation.oracle_passed == Some(false) {
                                    regressions = regressions
                                        .checked_add(1)
                                        .ok_or(EvaluationFailure::InternalFault)?;
                                }
                            }
                        }
                    }
                    // Empirical frequency only: no uncalibrated confidence interval or universal proof.
                    report.estimates.push(EffectEstimate {
                        split,
                        origin: kind,
                        metric: EvaluationMetric::Success,
                        estimate: success.clone(),
                        lower: None,
                        upper: None,
                        sample_size,
                    });
                }
                report.arms.push(ArmMetrics {
                    arm: arm.clone(),
                    split,
                    origin: kind,
                    success,
                    regression: numeric::ratio(regressions, comparisons),
                    dangerous_effects,
                    error_merge,
                    evidence_coverage,
                    conflict,
                    retraction_lag,
                    active_complexity,
                    migration_cost,
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cost: usage.cost,
                    full_latency: usage.elapsed,
                });
            }
        }
    }
    let mut accepted = true;
    let mut uncertain = replayability != Replayability::Complete
        || !report.coverage.missing_sources.is_empty()
        || !report.coverage.missing_tests.is_empty();
    for criterion in &suite.acceptance {
        match criterion {
            AcceptanceCriterion::HardCheck { name } => {
                for test in &suite.tests {
                    let checks: Vec<_> = results
                        .iter()
                        .filter(|result| {
                            result.evaluation.arm == EvaluationArm::Candidate
                                && result.evaluation.test == *test
                        })
                        .flat_map(|result| &result.hard_checks)
                        .filter(|check| check.name == *name)
                        .collect();
                    uncertain |= checks.len() != 1;
                    if checks.iter().any(|check| !check.passed) {
                        accepted = false;
                    }
                }
            }
            AcceptanceCriterion::NoDangerousEffect => {
                for result in results
                    .iter()
                    .filter(|result| result.evaluation.arm == EvaluationArm::Candidate)
                {
                    match result
                        .measurements
                        .as_ref()
                        .and_then(|value| value.dangerous_effects)
                    {
                        Some(0) => {}
                        Some(_) => accepted = false,
                        None => uncertain = true,
                    }
                }
            }
            AcceptanceCriterion::NoProtectedRegression => {
                if results.iter().any(|result| {
                    result.evaluation.arm == EvaluationArm::Candidate
                        && result.evaluation.oracle_passed == Some(false)
                        && suite
                            .protected_counterexamples
                            .contains(&result.evaluation.test)
                }) {
                    accepted = false;
                }
            }
            AcceptanceCriterion::Minimum { metric, value }
            | AcceptanceCriterion::Maximum { metric, value } => {
                let rows: Vec<_> = report
                    .arms
                    .iter()
                    .filter(|row| {
                        row.arm == EvaluationArm::Candidate && row.split == DatasetSplit::Holdout
                    })
                    .collect();
                uncertain |= rows.is_empty();
                // Every actually observed stratum must have a measured row; never silently drop one.
                uncertain |= results
                    .iter()
                    .filter(|result| {
                        result.evaluation.arm == EvaluationArm::Candidate
                            && tests.iter().any(|test| {
                                test.id == result.evaluation.test.id
                                    && test.revision == result.evaluation.test.revision
                                    && test.split == DatasetSplit::Holdout
                            })
                    })
                    .any(|result| {
                        !rows
                            .iter()
                            .any(|row| Some(row.origin) == origin(result, origins))
                    });
                for row in rows {
                    match metric_value(row, *metric) {
                        Some(actual)
                            if matches!(criterion, AcceptanceCriterion::Minimum { .. }) =>
                        {
                            accepted &= numeric::compare(&actual, value) != Ordering::Less;
                        }
                        Some(actual) => {
                            accepted &= numeric::compare(&actual, value) != Ordering::Greater
                        }
                        None => uncertain = true,
                    }
                }
            }
        }
    }
    if results
        .iter()
        .filter(|result| result.evaluation.arm == EvaluationArm::Candidate)
        .flat_map(|result| &result.hard_checks)
        .any(|check| !check.passed)
    {
        accepted = false;
    }
    report.verdict = if !accepted {
        CandidateVerdict::Rejected
    } else if uncertain {
        CandidateVerdict::Inconclusive
    } else {
        CandidateVerdict::Accepted
    };
    Ok(())
}

fn metric_value(
    row: &ArmMetrics,
    metric: EvaluationMetric,
) -> Option<world_protocol::value::Decimal> {
    Some(match metric {
        EvaluationMetric::Success => row.success.clone(),
        EvaluationMetric::Regression => row.regression.clone()?,
        EvaluationMetric::DangerousEffects => numeric::integer(row.dangerous_effects?),
        EvaluationMetric::ErrorMerge => row.error_merge.clone()?,
        EvaluationMetric::EvidenceCoverage => row.evidence_coverage.clone()?,
        EvaluationMetric::Conflict => row.conflict.clone()?,
        EvaluationMetric::RetractionLag => numeric::integer(row.retraction_lag?.0),
        EvaluationMetric::ActiveComplexity => numeric::integer(row.active_complexity?),
        EvaluationMetric::MigrationCost => row.migration_cost.clone()?,
        EvaluationMetric::Tokens => {
            numeric::integer(row.input_tokens.checked_add(row.output_tokens)?)
        }
        EvaluationMetric::Cost => row.cost.as_ref()?.amount.clone(),
        EvaluationMetric::FullLatency => numeric::integer(row.full_latency.0),
    })
}
