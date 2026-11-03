/** Matcha execution selection; Chrome tab facts and attachment state stay in TabManager. */
export class ExecutionScope {
  #options
  #selection = null
  #reservation = null

  constructor(options) {
    if (options !== undefined) {
      for (const name of ['getSelectedWindowId', 'getIsCurrentBrowserSelected']) {
        if (typeof options[name] !== 'function') throw new TypeError(`TabManager options requires ${name}`)
      }
    }
    this.#options = options
  }

  get enabled() { return this.#options !== undefined }
  get selectedWindowId() { return this.#options?.getSelectedWindowId() ?? null }
  get isCurrentBrowserSelected() { return this.#options?.getIsCurrentBrowserSelected() === true }
  get current() { return this.#selection }
  get reserved() {
    return this.#reservation && this.isCurrent(this.#reservation.selection)
      ? this.#reservation.selection
      : null
  }

  reserve(tabId) {
    if (this.reserved) throw new Error('Execution scope is busy')
    const selection = this.select(tabId)
    const reservation = { selection }
    this.#reservation = reservation
    return () => {
      if (this.#reservation !== reservation) return
      this.#reservation = null
      this.#options?.onExecutionScopeReleased?.()
    }
  }

  select(tabId, { manual = false } = {}) {
    if (!manual && this.reserved) return this.reserved
    const windowId = this.selectedWindowId
    const selected = this.isCurrentBrowserSelected
    if (
      this.#selection?.tabId !== tabId
      || this.#selection.windowId !== windowId
      || this.#selection.selected !== selected
    ) this.#selection = { tabId, windowId, selected }
    return this.#selection
  }

  isCurrent(selection) {
    return !this.enabled || (
      this.#selection === selection
      && selection?.windowId === this.selectedWindowId
      && selection?.selected === this.isCurrentBrowserSelected
    )
  }

  allows(tabId, entry, selection = this.#selection) {
    return !this.enabled || (
      this.isCurrent(selection)
      && selection?.selected === true
      && Number.isInteger(selection.windowId)
      && entry?.windowId === selection.windowId
      && tabId === selection.tabId
    )
  }

  async selectWindow(windowId, commandContext) {
    if (!Number.isInteger(windowId)) throw new TypeError('Execution window ID is required')
    if (this.enabled) {
      if (typeof this.#options.onExecutionWindowSelected !== 'function') {
        throw new Error('Execution window selection is unavailable')
      }
      await this.#options.onExecutionWindowSelected(windowId, commandContext)
    }
  }
}
