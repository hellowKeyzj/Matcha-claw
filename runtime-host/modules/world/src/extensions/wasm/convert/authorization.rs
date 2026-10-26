use super::*;

variant!(world_protocol::authorization::PolicyObligation, PolicyObligation; units [Approval, Audit, RevalidateBeforeEffect]; tuples []; records [Redact { fields } => PolicyObligationRedact, Limit { maximum } => PolicyObligationLimit]);
record!(world_protocol::authorization::PolicyRef, PolicyRef; policy_id, revision, contract, obligations);
unit_enum!(world_protocol::authorization::AccessMode, AccessMode; Read, Write, Execute, Approve, Publish, Manage, Export, Delete);
record!(world_protocol::authorization::PolicyBinding, PolicyBinding; name, policy, applies_to, scope, predicate, access, labels);
record!(world_protocol::authorization::AccessScope, AccessScope; resources, fields, modes, scope, valid_time);
record!(world_protocol::authorization::ActualImpact, ActualImpact; access, effects, labels, state, source_ids, digest);
record!(world_protocol::authorization::ApprovalBinding, ApprovalBinding; approval_id, action_digest, impact_digest, contract, expires_at);
unit_enum!(world_protocol::authorization::PolicyVerdict, PolicyVerdict; Allow, Deny, NeedsApproval);
