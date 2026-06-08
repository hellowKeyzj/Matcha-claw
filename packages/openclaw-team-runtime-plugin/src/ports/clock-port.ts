export interface ClockPort {
  nowMs(): number
}

export const systemClock: ClockPort = {
  nowMs: () => Date.now(),
}
