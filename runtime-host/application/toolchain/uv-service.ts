import type { RuntimePlatform } from '../common/runtime-ports';
import type { UvPythonInstallWorkflow } from '../workflows/toolchain-install/uv-python-install-workflow';
import type { ToolchainJobPort } from './toolchain-jobs';

export interface ToolchainUvRuntimePort {
  getPlatform(): RuntimePlatform;
  getBundledUvPathCandidates(): readonly string[];
}

export class ToolchainUvService {
  constructor(
    private readonly installWorkflow: Pick<UvPythonInstallWorkflow, 'checkInstalled' | 'executeInstall'>,
    private readonly jobs: ToolchainJobPort,
  ) {}

  async checkInstalled(): Promise<boolean> {
    return await this.installWorkflow.checkInstalled();
  }

  install() {
    return this.jobs.submitUvInstall();
  }

  async executeInstall() {
    return await this.installWorkflow.executeInstall();
  }
}
