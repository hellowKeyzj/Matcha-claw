import { randomUUID } from 'node:crypto'

export interface IdGeneratorPort {
  randomId(): string
}

export const cryptoIdGenerator: IdGeneratorPort = {
  randomId: () => randomUUID(),
}
