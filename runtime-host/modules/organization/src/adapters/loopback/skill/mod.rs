use platform::capability::CapabilityDecisionVerifier;

use std::path::PathBuf;

use serde_json::{Value, json};

use crate::OrganizationHandle;

const AUTHORIZATION_ENDPOINT: &str = "/api/team/skill";
const AUTHORIZATION_SCOPE: &str = "team:write";
const AUTHORIZATION_SUBJECT: &str = "team-skill-selection";
const AUTHORIZE_OPERATION: &str = "team.skill.authorize";
const VALIDATE_OPERATION: &str = "team.skill.validate";
const DEPENDENCY_PLAN_OPERATION: &str = "team.skill.dependency-plan";
const MATERIALIZE_OPERATION: &str = "team.skill.materialize";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum DecodeError {
    Unauthorized,
    Invalid,
}

pub(crate) enum Request {
    Authorize {
        package_root: PathBuf,
    },
    Validate {
        selection_id: organization::package::TeamSkillSelectionId,
    },
    DependencyPlan {
        selection_id: organization::package::TeamSkillSelectionId,
    },
    Materialize {
        selection_id: organization::package::TeamSkillSelectionId,
        team_id: organization::TeamId,
        idempotency_key: organization::IdempotencyKey,
    },
}

pub(crate) fn decode(
    value: Value,
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
) -> Result<Request, DecodeError> {
    let Value::Object(body) = value else {
        return Err(DecodeError::Invalid);
    };
    let Some(Value::String(operation)) = body.get("operation") else {
        return Err(DecodeError::Invalid);
    };
    match operation.as_str() {
        AUTHORIZE_OPERATION => {
            verify(authorization, verifier, now, AUTHORIZE_OPERATION)?;
            if body.len() != 2 {
                return Err(DecodeError::Invalid);
            }
            let Some(Value::String(package_root)) = body.get("packageRoot") else {
                return Err(DecodeError::Invalid);
            };
            valid_local_root(package_root)
                .then_some(Request::Authorize {
                    package_root: PathBuf::from(package_root),
                })
                .ok_or(DecodeError::Invalid)
        }
        VALIDATE_OPERATION | DEPENDENCY_PLAN_OPERATION => {
            verify(authorization, verifier, now, operation)?;
            if body.len() != 2 {
                return Err(DecodeError::Invalid);
            }
            let Some(Value::String(selection_id)) = body.get("selectionId") else {
                return Err(DecodeError::Invalid);
            };
            let selection_id =
                organization::package::TeamSkillSelectionId::parse(selection_id.clone())
                    .map_err(|_| DecodeError::Invalid)?;
            Ok(if operation == VALIDATE_OPERATION {
                Request::Validate { selection_id }
            } else {
                Request::DependencyPlan { selection_id }
            })
        }
        MATERIALIZE_OPERATION => {
            verify(authorization, verifier, now, MATERIALIZE_OPERATION)?;
            if body.len() != 4 {
                return Err(DecodeError::Invalid);
            }
            let Some(Value::String(selection_id)) = body.get("selectionId") else {
                return Err(DecodeError::Invalid);
            };
            let Some(Value::String(team_id)) = body.get("teamId") else {
                return Err(DecodeError::Invalid);
            };
            let Some(Value::String(idempotency_key)) = body.get("idempotencyKey") else {
                return Err(DecodeError::Invalid);
            };
            Ok(Request::Materialize {
                selection_id: organization::package::TeamSkillSelectionId::parse(
                    selection_id.clone(),
                )
                .map_err(|_| DecodeError::Invalid)?,
                team_id: organization::TeamId::try_new(team_id.clone())
                    .map_err(|_| DecodeError::Invalid)?,
                idempotency_key: organization::IdempotencyKey::try_new(idempotency_key.clone())
                    .map_err(|_| DecodeError::Invalid)?,
            })
        }
        _ => Err(DecodeError::Invalid),
    }
}

fn verify(
    authorization: &str,
    verifier: &mut CapabilityDecisionVerifier,
    now: u64,
    operation: &str,
) -> Result<(), DecodeError> {
    verifier
        .verify(
            authorization,
            now,
            AUTHORIZATION_ENDPOINT,
            AUTHORIZATION_SCOPE,
            operation,
            AUTHORIZATION_SUBJECT,
        )
        .map(|_| ())
        .map_err(|_| DecodeError::Unauthorized)
}

pub(crate) enum Delivery {
    Authorized(organization::package::TeamSkillSelectionId),
    Validation(organization::package::TeamSkillPackageValidation),
    DependencyPlan(organization::package::TeamSkillDependencyPlanResult),
    Materialized,
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

impl Delivery {
    pub(crate) fn status_code(&self) -> u16 {
        match self {
            Self::Authorized(_)
            | Self::Validation(_)
            | Self::DependencyPlan(_)
            | Self::Materialized
            | Self::Rejected
            | Self::OutcomeUnknown => 200,
            Self::Unavailable => 503,
        }
    }

    pub(crate) fn body(&self) -> Value {
        match self {
            Self::Authorized(selection_id) => json!({ "selectionId": selection_id.as_str() }),
            Self::Validation(validation) => validation_body(validation),
            Self::DependencyPlan(plan) => dependency_plan_body(plan),
            Self::Materialized => json!({ "status": "materialized" }),
            Self::Rejected => json!({ "status": "rejected" }),
            Self::OutcomeUnknown => json!({ "status": "outcome_unknown" }),
            Self::Unavailable => json!({
                "success": false,
                "error": "TeamSkill selection is unavailable",
            }),
        }
    }
}

fn validation_body(validation: &organization::package::TeamSkillPackageValidation) -> Value {
    match validation {
        organization::package::TeamSkillPackageValidation::Valid { package } => json!({
            "status": "valid",
            "package": {
                "selectionId": package.selection_id().as_str(),
                "name": package.name(),
                "version": package.version(),
                "kind": "team-skill",
                "description": package.description(),
            },
        }),
        organization::package::TeamSkillPackageValidation::Invalid => {
            json!({ "status": "invalid" })
        }
        organization::package::TeamSkillPackageValidation::Unavailable => {
            json!({ "status": "unavailable" })
        }
    }
}

fn dependency_plan_body(plan: &organization::package::TeamSkillDependencyPlanResult) -> Value {
    match plan {
        organization::package::TeamSkillDependencyPlanResult::Available { plan } => json!({
            "status": "available",
            "plan": dependency_plan_value(plan),
        }),
        organization::package::TeamSkillDependencyPlanResult::Invalid => {
            json!({ "status": "invalid" })
        }
        organization::package::TeamSkillDependencyPlanResult::Unavailable => {
            json!({ "status": "unavailable" })
        }
    }
}

fn dependency_plan_value(plan: &organization::package::TeamSkillDependencyPlan) -> Value {
    json!({
        "selectionId": plan.selection_id().as_str(),
        "packageName": plan.package_name(),
        "packageVersion": plan.package_version(),
        "items": plan
            .items()
            .iter()
            .map(dependency_plan_item_value)
            .collect::<Vec<_>>(),
        "canProceed": plan.can_proceed(),
    })
}

fn dependency_plan_item_value(item: &organization::package::TeamSkillDependencyPlanItem) -> Value {
    json!({
        "kind": dependency_kind_code(item.kind()),
        "name": item.name(),
        "required": item.required(),
        "purpose": item.purpose(),
        "status": dependency_status_code(item.status()),
        "severity": dependency_severity_code(item.severity()),
        "installable": item.installable(),
    })
}

fn dependency_kind_code(kind: organization::package::TeamSkillDependencyKind) -> &'static str {
    match kind {
        organization::package::TeamSkillDependencyKind::Skill => "skill",
        organization::package::TeamSkillDependencyKind::Tool => "tool",
    }
}

fn dependency_status_code(
    status: organization::package::TeamSkillDependencyStatus,
) -> &'static str {
    match status {
        organization::package::TeamSkillDependencyStatus::Available => "available",
        organization::package::TeamSkillDependencyStatus::Missing => "missing",
    }
}

fn dependency_severity_code(
    severity: organization::package::TeamSkillDependencySeverity,
) -> &'static str {
    match severity {
        organization::package::TeamSkillDependencySeverity::Ok => "ok",
        organization::package::TeamSkillDependencySeverity::Warning => "warning",
        organization::package::TeamSkillDependencySeverity::Blocker => "blocker",
    }
}

pub(crate) async fn dispatch(owner: &OrganizationHandle, request: Request) -> Delivery {
    match request {
        Request::Authorize { package_root } => owner
            .team_skill_authorize(package_root)
            .await
            .ok()
            .and_then(Result::ok)
            .map_or(Delivery::Unavailable, Delivery::Authorized),
        Request::Validate { selection_id } => owner
            .team_skill_selection_validate(selection_id)
            .await
            .map_or(Delivery::Unavailable, Delivery::Validation),
        Request::DependencyPlan { selection_id } => owner
            .team_skill_selection_dependency_plan(selection_id)
            .await
            .map_or(Delivery::Unavailable, Delivery::DependencyPlan),
        Request::Materialize {
            selection_id,
            team_id,
            idempotency_key,
        } => match owner
            .team_skill_materialize(selection_id, team_id, idempotency_key)
            .await
        {
            Ok(crate::TeamMaterializationCommandOutcome::Materialized { .. }) => {
                Delivery::Materialized
            }
            Ok(crate::TeamMaterializationCommandOutcome::Rejected) => Delivery::Rejected,
            Ok(crate::TeamMaterializationCommandOutcome::OutcomeUnknown) => {
                Delivery::OutcomeUnknown
            }
            Ok(crate::TeamMaterializationCommandOutcome::Unavailable) | Err(_) => {
                Delivery::Unavailable
            }
        },
    }
}

fn valid_local_root(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains('\0')
        && !value.chars().any(char::is_control)
        && PathBuf::from(value).is_absolute()
}

pub(crate) mod handler;

#[cfg(test)]
mod tests {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    use super::*;

    #[test]
    fn decodes_only_authorize_or_sealed_selection_requests() {
        assert!(matches!(
            decode_with_authorization(
                json!({
                    "operation": AUTHORIZE_OPERATION,
                    "packageRoot": "C:/private/skill",
                }),
                AUTHORIZE_OPERATION
            ),
            Ok(Request::Authorize { .. })
        ));
        assert!(matches!(
            decode_with_authorization(
                json!({
                    "operation": VALIDATE_OPERATION,
                    "selectionId": valid_selection(),
                }),
                VALIDATE_OPERATION
            ),
            Ok(Request::Validate { .. })
        ));
        assert!(matches!(
            decode_with_authorization(
                json!({
                    "operation": MATERIALIZE_OPERATION,
                    "selectionId": valid_selection(),
                    "teamId": "team-1",
                    "idempotencyKey": "materialize-1",
                }),
                MATERIALIZE_OPERATION
            ),
            Ok(Request::Materialize { .. })
        ));
        for malformed in [
            json!({ "operation": MATERIALIZE_OPERATION, "selectionId": valid_selection(), "teamId": "team-1" }),
            json!({ "operation": MATERIALIZE_OPERATION, "selectionId": valid_selection(), "teamId": "  ", "idempotencyKey": "materialize-1" }),
            json!({ "operation": MATERIALIZE_OPERATION, "selectionId": valid_selection(), "teamId": "team-1", "idempotencyKey": " ", "workspace": "C:/private" }),
            json!({ "operation": VALIDATE_OPERATION, "packageRoot": "C:/private/skill" }),
            json!({ "operation": DEPENDENCY_PLAN_OPERATION, "selectionId": valid_selection(), "source": "clawhub:web" }),
            json!({ "operation": AUTHORIZE_OPERATION, "packageRoot": "C:\\private\nskill" }),
        ] {
            assert!(matches!(
                decode_with_authorization(malformed, AUTHORIZE_OPERATION),
                Err(DecodeError::Invalid) | Err(DecodeError::Unauthorized)
            ));
        }
    }

    #[test]
    fn rejects_a_decision_for_another_teamskill_operation() {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        assert!(matches!(
            decode(
                json!({
                    "operation": MATERIALIZE_OPERATION,
                    "selectionId": valid_selection(),
                    "teamId": "team-1",
                    "idempotencyKey": "materialize-1",
                }),
                &decision(AUTHORIZE_OPERATION),
                &mut verifier,
                1,
            ),
            Err(DecodeError::Unauthorized),
        ));
    }

    #[test]
    fn materialize_delivery_is_closed_and_redacted() {
        assert_eq!(
            Delivery::Materialized.body(),
            json!({ "status": "materialized" })
        );
        assert_eq!(Delivery::Rejected.body(), json!({ "status": "rejected" }));
        assert_eq!(
            Delivery::OutcomeUnknown.body(),
            json!({ "status": "outcome_unknown" }),
        );
    }

    #[test]
    fn unavailable_delivery_is_fixed_and_redacted() {
        assert_eq!(
            Delivery::Unavailable.body(),
            json!({ "success": false, "error": "TeamSkill selection is unavailable" }),
        );
    }

    fn valid_selection() -> String {
        format!("teamskill:v1:{}", "a".repeat(64))
    }

    fn decode_with_authorization(value: Value, operation: &str) -> Result<Request, DecodeError> {
        let mut verifier = CapabilityDecisionVerifier::try_new(&verification_key()).unwrap();
        decode(value, &decision(operation), &mut verifier, 1)
    }

    fn signing_key() -> SigningKey {
        SigningKey::from_bytes(&[30; 32])
    }

    fn verification_key() -> String {
        let mut bytes = vec![
            0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
        ];
        bytes.extend_from_slice(signing_key().verifying_key().as_bytes());
        URL_SAFE_NO_PAD.encode(bytes)
    }

    fn decision(operation: &str) -> String {
        let payload = json!({
            "version": 1,
            "principal": "localhost-test",
            "endpoint": AUTHORIZATION_ENDPOINT,
            "scope": AUTHORIZATION_SCOPE,
            "capability": operation,
            "subject": AUTHORIZATION_SUBJECT,
            "expiresAt": 60_000,
            "correlation": "team-skill-test",
            "revision": "test",
        });
        let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        let signed = format!("capability-decision.v1.{payload}");
        let signature = URL_SAFE_NO_PAD.encode(signing_key().sign(signed.as_bytes()).to_bytes());
        format!("{signed}.{signature}")
    }
}
