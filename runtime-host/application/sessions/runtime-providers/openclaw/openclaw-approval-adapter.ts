import { buildCanonicalApprovalEventsFromGatewayNotification, type CanonicalApprovalNotification } from '../../canonical/canonical-approval-events';
import type { CanonicalApprovalEvent } from '../../canonical/canonical-events';

export type { CanonicalApprovalNotification } from '../../canonical/canonical-approval-events';

export class OpenClawApprovalAdapter {
  translateNotification(notification: CanonicalApprovalNotification, nowMs: number): CanonicalApprovalEvent[] {
    return buildCanonicalApprovalEventsFromGatewayNotification(notification, nowMs);
  }
}
