export type RuntimeEndpointRef = NativeRuntimeEndpointRef | ProtocolConnectorRuntimeEndpointRef

export interface NativeRuntimeEndpointRef {
  kind: 'native-runtime'
  runtimeAdapterId: string
  runtimeInstanceId: string
}

export interface ProtocolConnectorRuntimeEndpointRef {
  kind: 'protocol-connector'
  protocolId: string
  connectorId: string
  endpointId: string
}

export type TeamInboundEnvelope =
  | TeamWorkflowPlanSubmittedEnvelope
  | TeamTaskCompletedEnvelope
  | TeamMessageSentEnvelope
  | TeamApprovalRequestedEnvelope
  | TeamArtifactPublishedEnvelope
  | TeamArtifactUpdatedEnvelope
  | TeamGateOpenedEnvelope
  | TeamGateResolvedEnvelope

export interface TeamInboundEnvelopeBase {
  readonly envelopeId: string
  readonly runId: string
  readonly sourceEndpoint: RuntimeEndpointRef
  readonly sourceAgentId: string
  readonly sourceSessionKey?: string
  readonly sourceRoleId?: string
  readonly workflowTaskId?: string
  readonly idempotencyKey: string
  readonly createdAt: number
}

export interface TeamWorkflowPlanSubmittedEnvelope extends TeamInboundEnvelopeBase {
  readonly type: 'workflow.plan_submitted'
  readonly title: string
  readonly summary?: string
  readonly groups: readonly TeamWorkflowGroupPlan[]
  readonly tasks: readonly TeamWorkflowTaskPlan[]
}

export interface TeamWorkflowGroupPlan {
  readonly groupId: string
  readonly title: string
  readonly taskIds: readonly string[]
  readonly join: {
    readonly requireCompleted: boolean
    readonly allowFailed: boolean
    readonly retryLimit: number
  }
}

export interface TeamWorkflowTaskPlan {
  readonly taskId: string
  readonly roleId: string
  readonly title: string
  readonly prompt: string
  readonly dependsOnTaskIds?: readonly string[]
  readonly outputArtifactKind?: string
}

export type TeamEvidenceRef =
  | { readonly type: 'workspacePath'; readonly path: string; readonly label?: string }
  | { readonly type: 'uri'; readonly uri: string; readonly label?: string }
  | { readonly type: 'artifact'; readonly artifactId: string; readonly label?: string }
  | { readonly type: 'inlineText'; readonly text: string; readonly label?: string }

export interface TeamFailureItem {
  readonly code: string
  readonly message: string
  readonly severity?: 'info' | 'warning' | 'blocker'
  readonly evidenceRefs?: readonly TeamEvidenceRef[]
}

export interface TeamTaskCompletedEnvelope extends TeamInboundEnvelopeBase {
  readonly type: 'task.completed'
  readonly workflowTaskId: string
  readonly roleId: string
  readonly summary: string
  readonly evidenceRefs?: readonly TeamEvidenceRef[]
}

export type TeamMessageKind = 'note' | 'question' | 'kickback'

export interface TeamMessageSentEnvelope extends TeamInboundEnvelopeBase {
  readonly type: 'message.sent'
  readonly kind: TeamMessageKind
  readonly fromRoleId: string
  readonly toRoleId: string
  readonly summary: string
  readonly body: string
  readonly relatedTaskId?: string
  readonly relatedArtifactId?: string
  readonly relatedGateId?: string
  readonly failureItems?: readonly TeamFailureItem[]
}

export interface TeamApprovalRequestedEnvelope extends TeamInboundEnvelopeBase {
  readonly type: 'approval.requested'
  readonly workflowTaskId: string
  readonly roleId: string
  readonly reason: string
  readonly requestedAction: string
  readonly risk: string
}

export interface TeamArtifactPublishedEnvelope extends TeamInboundEnvelopeBase {
  readonly type: 'artifact.published'
  readonly artifactId?: string
  readonly stageId: string
  readonly roleId: string
  readonly kind: string
  readonly title: string
  readonly contentRef: string
  readonly summary?: string
  readonly evidenceRefs?: readonly TeamEvidenceRef[]
  readonly relatedTaskId?: string
}

export interface TeamArtifactUpdatedEnvelope extends TeamInboundEnvelopeBase {
  readonly type: 'artifact.updated'
  readonly artifactId: string
  readonly stageId?: string
  readonly roleId?: string
  readonly kind?: string
  readonly title?: string
  readonly contentRef?: string
  readonly summary?: string
  readonly evidenceRefs?: readonly TeamEvidenceRef[]
  readonly relatedTaskId?: string
  readonly relatedGateId?: string
}

export interface TeamGateOpenedEnvelope extends TeamInboundEnvelopeBase {
  readonly type: 'gate.opened'
  readonly gateId?: string
  readonly stageId: string
  readonly gateType: string
  readonly subjectArtifactId?: string
  readonly relatedTaskId?: string
  readonly blocking: boolean
  readonly summary: string
  readonly failureItems?: readonly TeamFailureItem[]
}

export interface TeamGateResolvedEnvelope extends TeamInboundEnvelopeBase {
  readonly type: 'gate.resolved'
  readonly gateId: string
  readonly stageId?: string
  readonly gateType?: string
  readonly verdict: string
  readonly passed: boolean
  readonly failureItems?: readonly TeamFailureItem[]
  readonly resolutionSummary?: string
}

export type TeamOutboxRecordStatus = 'pending' | 'claimed' | 'acked'

export interface TeamOutboxRecord {
  readonly recordId: string
  readonly runId: string
  readonly sequence: number
  readonly idempotencyKey: string
  readonly envelope: TeamInboundEnvelope
  readonly status: TeamOutboxRecordStatus
  readonly claimedBy?: string
  readonly claimExpiresAt?: number
  readonly ackedAt?: number
  readonly createdAt: number
}
