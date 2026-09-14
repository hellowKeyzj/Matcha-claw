/**
 * Renderer-only opaque target projection for fixed product transports.
 * Runtime Host does not decode this shape as a dynamic routing grammar.
 */
export type CapabilityTarget = Readonly<{
  kind: string;
  readonly [field: string]: unknown;
}>;

export type CapabilityTargetKind = CapabilityTarget['kind'];
