use super::*;
use tokio_util::sync::CancellationToken;

use crate::team::{materialization, native_effects, profiles};

impl organization::OrganizationNativeRuntime for MatchaRuntimeDriver {
    fn read_team_member_profiles(
        &self,
        agents: Vec<organization::ManagedAgentReference>,
    ) -> OwnedRuntimeFuture<
        Result<Vec<organization::MemberProfile>, organization::TeamCreationFailure>,
    > {
        self.read_team_member_profiles_cancellable(agents, CancellationToken::new())
    }

    fn read_team_member_profiles_cancellable(
        &self,
        agents: Vec<organization::ManagedAgentReference>,
        cancellation: CancellationToken,
    ) -> OwnedRuntimeFuture<
        Result<Vec<organization::MemberProfile>, organization::TeamCreationFailure>,
    > {
        Box::pin(profiles::read(self.native_client(), agents, cancellation))
    }

    fn materialize_team(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        self.materialize_team_cancellable(request, None, CancellationToken::new())
    }

    fn materialize_team_observed(
        &self,
        request: organization::TeamMaterializationRequest,
        observer: Option<organization::TeamProvisionObserver>,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        self.materialize_team_cancellable(request, observer, CancellationToken::new())
    }

    fn materialize_team_cancellable(
        &self,
        request: organization::TeamMaterializationRequest,
        observer: Option<organization::TeamProvisionObserver>,
        cancellation: CancellationToken,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(materialization::materialize(
            self.native_client(),
            request,
            observer,
            cancellation,
        ))
    }

    fn recover_team_materialization(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(materialization::recover(
            self.native_client(),
            request,
            CancellationToken::new(),
        ))
    }

    fn remove_team(
        &self,
        removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        self.remove_team_cancellable(removal, CancellationToken::new())
    }

    fn remove_team_cancellable(
        &self,
        removal: organization::TeamMaterializationRemoval,
        cancellation: CancellationToken,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(materialization::remove(
            self.native_client(),
            removal,
            cancellation,
        ))
    }

    fn remove_unconfirmed_team(
        &self,
        request: organization::TeamMaterializationRequest,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        self.remove_unconfirmed_team_cancellable(request, CancellationToken::new())
    }

    fn remove_unconfirmed_team_cancellable(
        &self,
        request: organization::TeamMaterializationRequest,
        cancellation: CancellationToken,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(materialization::remove_unconfirmed(
            self.native_client(),
            request,
            cancellation,
        ))
    }

    fn recover_team_removal(
        &self,
        removal: organization::TeamMaterializationRemoval,
    ) -> OwnedRuntimeFuture<organization::MaterializationOperationOutcome> {
        Box::pin(materialization::recover_removal(
            self.native_client(),
            removal,
            CancellationToken::new(),
        ))
    }

    fn confirm_team_run_receipt(
        &self,
        receipt: organization::RunRuntimeReceipt,
    ) -> OwnedRuntimeFuture<organization::RuntimeReceiptOutcome> {
        let confirmation =
            self.confirm_team_run_receipt_cancellable(receipt, CancellationToken::new());
        Box::pin(async move { confirmation.await.0 })
    }

    fn confirm_team_run_receipt_cancellable(
        &self,
        receipt: organization::RunRuntimeReceipt,
        cancellation: CancellationToken,
    ) -> OwnedRuntimeFuture<(
        organization::RuntimeReceiptOutcome,
        Option<organization::TeamCreationFailure>,
    )> {
        Box::pin(native_effects::confirm(
            self.native_client(),
            receipt,
            cancellation,
        ))
    }

    fn abort_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        self.abort_role_sessions_cancellable(bindings, CancellationToken::new())
    }

    fn abort_role_sessions_cancellable(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
        cancellation: CancellationToken,
    ) -> OwnedRuntimeFuture<organization::RoleAbortOutcome> {
        Box::pin(native_effects::abort(
            self.native_client(),
            bindings,
            cancellation,
        ))
    }

    fn delete_role_sessions(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        self.delete_role_sessions_cancellable(
            run_id,
            bindings,
            abort_first,
            CancellationToken::new(),
        )
    }

    fn delete_role_sessions_cancellable(
        &self,
        run_id: organization::GraphRunId,
        bindings: Vec<organization::RoleSessionReceipt>,
        abort_first: bool,
        cancellation: CancellationToken,
    ) -> OwnedRuntimeFuture<organization::NativeDeletionEvidence> {
        Box::pin(native_effects::delete(
            self.native_client(),
            run_id,
            bindings,
            abort_first,
            cancellation,
        ))
    }

    fn retire_unconfirmed_role_sessions(
        &self,
        bindings: Vec<organization::RoleSessionReceipt>,
        cancellation: CancellationToken,
    ) -> OwnedRuntimeFuture<organization::ports::native_effects::RoleSessionRetirementOutcome> {
        Box::pin(native_effects::retire_unconfirmed(
            self.native_client(),
            bindings,
            cancellation,
        ))
    }

    fn installed_skill_names(
        &self,
        source_agent: Option<organization::ManagedAgentReference>,
    ) -> OwnedRuntimeFuture<Option<Vec<String>>> {
        let client = self.native_client();
        Box::pin(async move {
            let source = source_agent?;
            profiles::agent(&client, source.as_str(), &CancellationToken::new())
                .await
                .ok()?;
            let catalog = crate::skills::Skills::new(client)
                .list(source.as_str())
                .await
                .ok()?;
            Some(catalog.skills.into_iter().map(|skill| skill.name).collect())
        })
    }
}
