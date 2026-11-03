/** Window-local groups owned by this extension, never adopted by their title. */
import { createLogger } from '../../logger.js'
import {
  CommandDeadlineExceededError,
  awaitWithDeadline,
} from '../commands/deadline.js'

const log = createLogger('group')

export const TAB_GROUP_TITLE = 'MatchaClaw Agent'
const TAB_GROUP_COLOR = 'blue'
const OWNED_GROUPS_KEY = 'matcha_ownedAgentGroups'

export class AgentGroupManager {
  /** @type {Map<number, number>} windowId → active groupId */
  #groups = new Map()
  /** @type {Map<number, number>} groupId → windowId, native creation receipts only */
  #ownedGroups = new Map()
  #loaded = false
  #epoch = 0
  #queue = Promise.resolve()

  get groupId() { return this.groupIds[0] ?? null }
  get groupIds() { return [...this.#groups.values()] }

  reset() {
    this.#epoch++
    this.#groups.clear()
  }

  #enqueue(context, task) {
    const pending = this.#queue.then(task)
    // The public wait may expire; mutations still serialize on native settlement.
    this.#queue = pending.catch(() => {})
    context?.trackNativeOperation?.(pending)
    return context
      ? awaitWithDeadline(context, 'agent_group.queue_wait', () => pending)
      : pending
  }

  async #checkCurrent(context, epoch) {
    if (context) await awaitWithDeadline(context, 'agent_group.current', () => undefined)
    return epoch === this.#epoch
  }

  async #loadOwnedGroups() {
    if (this.#loaded) return
    const stored = await chrome.storage.session.get(OWNED_GROUPS_KEY)
    for (const group of stored[OWNED_GROUPS_KEY] ?? []) {
      if (Number.isInteger(group.id) && Number.isInteger(group.windowId)) {
        this.#ownedGroups.set(group.id, group.windowId)
      }
    }
    this.#loaded = true
  }

  async #persistOwnedGroups() {
    await chrome.storage.session.set({
      [OWNED_GROUPS_KEY]: [...this.#ownedGroups].map(([id, windowId]) => ({ id, windowId })),
    })
  }

  async addTab(tabId, commandContext) {
    const context = commandContext
    const epoch = this.#epoch
    return this.#enqueue(context, async () => {
      try {
        if (!(await this.#checkCurrent(context, epoch))) return
        await this.#loadOwnedGroups()
        if (!(await this.#checkCurrent(context, epoch))) return
        let tab = await chrome.tabs.get(tabId)
        const windowId = tab.windowId
        let groupId = null
        for (const [id, ownedWindowId] of this.#ownedGroups) {
          if (ownedWindowId !== windowId) continue
          if (!(await this.#checkCurrent(context, epoch))) return
          let group
          try {
            group = await chrome.tabGroups.get(id)
          } catch {
            this.#ownedGroups.delete(id)
            this.#groups.delete(windowId)
            await this.#persistOwnedGroups()
            continue
          }
          if (group.windowId !== windowId) continue
          groupId = id
          break
        }
        if (!(await this.#checkCurrent(context, epoch))) return
        tab = await chrome.tabs.get(tabId)
        // A user move while we were checking the group is not permission to move back.
        if (tab.windowId !== windowId || !(await this.#checkCurrent(context, epoch))) return
        if (tab.groupId !== groupId || groupId === null) {
          const createdGroup = groupId === null
          const result = await chrome.tabs.group({
            tabIds: [tabId],
            ...(createdGroup ? { createProperties: { windowId } } : { groupId }),
          })
          if (createdGroup) {
            // Keep provenance even if the caller expired during the native creation.
            this.#ownedGroups.set(result, windowId)
            await this.#persistOwnedGroups()
          }
          groupId = result
        }
        if (!(await this.#checkCurrent(context, epoch))) return
        if (this.#ownedGroups.get(groupId) !== windowId) return
        await chrome.tabGroups.update(groupId, {
          title: TAB_GROUP_TITLE,
          color: TAB_GROUP_COLOR,
          collapsed: false,
        })
        if (await this.#checkCurrent(context, epoch)) this.#groups.set(windowId, groupId)
      } catch (err) {
        if (err instanceof CommandDeadlineExceededError) throw err
        log.warn('addTab: failed for tab', tabId, err)
      }
    })
  }

  /** Only the supplied, non-retained agent-owned tabs can be closed. */
  async dissolve(agentTabIds = new Set()) {
    this.reset()
    const epoch = this.#epoch
    await this.#enqueue(null, async () => {
      if (epoch !== this.#epoch) return
      await this.#loadOwnedGroups()
      for (const [groupId, windowId] of this.#ownedGroups) {
        if (epoch !== this.#epoch) return
        try {
          const group = await chrome.tabGroups.get(groupId)
          if (group.windowId !== windowId) continue
          const tabs = await chrome.tabs.query({ groupId })
          const ids = tabs
            .filter((tab) => tab.windowId === windowId && Number.isInteger(tab.id))
            .map((tab) => tab.id)
          const toClose = ids.filter((id) => agentTabIds.has(id))
          const toUngroup = ids.filter((id) => !agentTabIds.has(id))
          if (toClose.length > 0) {
            if (epoch !== this.#epoch) return
            await chrome.tabs.remove(toClose)
          }
          if (toUngroup.length > 0) {
            if (epoch !== this.#epoch) return
            await chrome.tabs.ungroup(toUngroup)
          }
          this.#ownedGroups.delete(groupId)
          await this.#persistOwnedGroups()
        } catch (err) {
          log.warn('dissolve: failed for owned group', groupId, err)
        }
      }
    })
  }
}
