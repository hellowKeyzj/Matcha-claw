"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TEAM_MANAGED_AGENT_KIND = exports.TEAM_MANAGED_AGENT_SANDBOX = exports.TEAM_MANAGED_AGENT_TOOLS_PROFILE = exports.TEAM_LEADER_RUNTIME_TOOLS = exports.TEAM_ROLE_RUNTIME_TOOLS = exports.TEAM_ROLE_MANAGED_DENIED_TOOLS = exports.TEAM_LEADER_MANAGED_DENIED_TOOLS = exports.TEAM_MANAGED_AGENT_CONFIG_SOURCE = exports.TEAM_MANAGED_AGENT_CONFIG_VERSION = exports.TEAM_MANAGED_AGENT_CONFIG_KIND = exports.TEAM_LEADER_ROLE_ID = exports.TEAM_AGENT_ID_PREFIX = void 0;
exports.buildTeamManagedAgentId = buildTeamManagedAgentId;
exports.teamManagedAgentRunPrefix = teamManagedAgentRunPrefix;
exports.TEAM_AGENT_ID_PREFIX = 'mct-';
exports.TEAM_LEADER_ROLE_ID = 'leader';
exports.TEAM_MANAGED_AGENT_CONFIG_KIND = 'matchaclaw-team-managed-openclaw-agents';
exports.TEAM_MANAGED_AGENT_CONFIG_VERSION = 1;
exports.TEAM_MANAGED_AGENT_CONFIG_SOURCE = 'matchaclaw.team-runtime';
exports.TEAM_LEADER_MANAGED_DENIED_TOOLS = ['sessions_yield', 'subagents'];
exports.TEAM_ROLE_MANAGED_DENIED_TOOLS = ['sessions_spawn', 'sessions_yield', 'subagents'];
exports.TEAM_ROLE_RUNTIME_TOOLS = ['team_submit_artifact', 'team_send_message', 'team_request_approval', 'team_update_task'];
exports.TEAM_LEADER_RUNTIME_TOOLS = ['team_plan_workflow'];
exports.TEAM_MANAGED_AGENT_TOOLS_PROFILE = 'full';
exports.TEAM_MANAGED_AGENT_SANDBOX = { mode: 'off', scope: 'agent', workspaceAccess: 'rw' };
exports.TEAM_MANAGED_AGENT_KIND = 'team-role-agent';
function buildTeamManagedAgentId(runId, roleId) {
    const runHash = stableHash(runId);
    const roleHash = stableHash(roleId);
    const roleSlug = slugId(roleId).slice(0, 32).replace(/-+$/g, '') || 'role';
    return `${exports.TEAM_AGENT_ID_PREFIX}${runHash}-${roleSlug}-${roleHash}`;
}
function teamManagedAgentRunPrefix(runId) {
    return `${exports.TEAM_AGENT_ID_PREFIX}${stableHash(runId)}-`;
}
function slugId(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
}
function stableHash(value) {
    let hash = 2166136261;
    for (const char of value) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36).padStart(7, '0');
}
