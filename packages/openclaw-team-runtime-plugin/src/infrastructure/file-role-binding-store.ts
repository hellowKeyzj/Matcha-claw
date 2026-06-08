import path from 'node:path'
import type { TeamRoleBinding } from '../domain/team-role.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'

export class FileRoleBindingStore {
  async save(runtimeRoot: string, roles: TeamRoleBinding[]): Promise<TeamRoleBinding[]> {
    await atomicWriteJson(this.rolesPath(runtimeRoot), roles)
    return roles
  }

  async read(runtimeRoot: string): Promise<TeamRoleBinding[]> {
    return await readJsonFile<TeamRoleBinding[]>(this.rolesPath(runtimeRoot)) ?? []
  }

  private rolesPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'roles.json')
  }
}
