/** Diagnostic output is enabled only by the relay's encrypted handshake. */
let traceEnabled = false

export function setTraceEnabled(enabled) {
  traceEnabled = enabled === true
}

export function isTraceEnabled() {
  return traceEnabled
}

/**
 * Create a tagged logger. Diagnostic arguments are evaluated only when enabled.
 * @param {string} module — short tag (e.g. 'relay', 'tabs', 'cdp', 'bg')
 */
export function createLogger(module) {
  const prefix = `[matchaclaw:${module}]`

  return {
    debug(args) {
      if (traceEnabled) console.debug(prefix, ...args())
    },

    info(args) {
      if (traceEnabled) console.info(prefix, ...args())
    },

    warn(...args) {
      console.warn(prefix, ...args)
    },

    error(...args) {
      console.error(prefix, ...args)
    },
  }
}
