import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';

export interface RuntimeHostDeliveryDecisionInput {
  readonly principal: string;
  readonly endpoint: string;
  readonly scope: string;
  readonly capability: string;
  readonly subject: string;
  readonly expiresAt: number;
  readonly revision: string;
  readonly correlation?: string;
}

export interface RuntimeHostDeliveryIssuer {
  readonly verificationKey: string;
  readonly signDecision: (input: RuntimeHostDeliveryDecisionInput) => string;
}

export function createRuntimeHostDeliveryIssuer(): RuntimeHostDeliveryIssuer {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    verificationKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    signDecision: (input) => {
      validateDecisionInput(input);
      const payload = Buffer.from(
        JSON.stringify({
          version: 1,
          principal: input.principal,
          endpoint: input.endpoint,
          scope: input.scope,
          capability: input.capability,
          subject: input.subject,
          expiresAt: input.expiresAt,
          correlation: input.correlation ?? `corr:${randomUUID()}`,
          revision: input.revision,
        })
      ).toString('base64url');
      const signed = `capability-decision.v1.${payload}`;
      return `${signed}.${sign(null, Buffer.from(signed), privateKey).toString('base64url')}`;
    },
  };
}

function validateDecisionInput(input: RuntimeHostDeliveryDecisionInput): void {
  const values = [
    input.principal,
    input.endpoint,
    input.scope,
    input.capability,
    input.subject,
    input.revision,
    input.correlation,
  ];
  if (
    values.some(
      (value) =>
        value !== undefined &&
        (typeof value !== 'string' || !value || value.length > 256 || value.includes('\0'))
    ) ||
    !Number.isSafeInteger(input.expiresAt) ||
    input.expiresAt <= Date.now()
  ) {
    throw new RangeError('Runtime-host capability decision input is invalid.');
  }
}
