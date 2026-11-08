import catalog from '../../../../runtime-host/modules/provider/src/application/model_reference_catalog.json'
import { normalizeModelStringForAPI } from './configs.js'

export type ModelReasoningProtocol =
  | 'openaiCompletions'
  | 'openaiResponses'
  | 'anthropicMessages'
  | 'googleGenerativeAi'

/** Model metadata never rewrites the identifier sent to the provider. */
export function getModelReasoningEfforts(
  model: string,
  protocol: ModelReasoningProtocol,
): readonly string[] | undefined {
  const id = normalizeModelStringForAPI(model).trim()
  const record =
    catalog.models.find(record => record.modelId === id) ??
    catalog.models.find(
      record =>
        record.modelId.toLowerCase() === id.split('/').at(-1)?.toLowerCase(),
    )
  const efforts:
    | Partial<Record<ModelReasoningProtocol, readonly string[]>>
    | undefined = record?.reasoningEfforts
  return efforts?.[protocol]
}
