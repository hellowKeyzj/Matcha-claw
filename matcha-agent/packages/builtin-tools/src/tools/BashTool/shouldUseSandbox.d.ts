type SandboxInput = {
  command?: string
  dangerouslyDisableSandbox?: boolean
}
export declare function shouldUseSandbox(input: Partial<SandboxInput>): boolean
export {}
