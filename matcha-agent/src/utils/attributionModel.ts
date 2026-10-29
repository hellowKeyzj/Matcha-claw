import {
  getMainLoopModel,
  normalizeModelStringForAPI,
} from './model/model.js'

export function getRealModelName(): string {
  return normalizeModelStringForAPI(getMainLoopModel())
}
