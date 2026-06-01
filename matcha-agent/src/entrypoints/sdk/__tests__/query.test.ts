import { describe, expect, test } from 'bun:test'
import {
  SDKControlReadFileContentRequestSchema,
  SDKControlReadFileContentResponseSchema,
  SDKControlRequestInnerSchema,
} from '../controlSchemas.js'

describe('readFileContent control schema', () => {
  test('accepts multimedia read requests and responses', () => {
    const request = {
      subtype: 'read_file_content',
      path: 'image.png',
      offset: 2,
      limit: 5,
      pages: '1-2',
      maxTokens: 1000,
      maxSizeBytes: 2000,
    } as const

    expect(SDKControlReadFileContentRequestSchema().parse(request)).toEqual(
      request,
    )
    expect(SDKControlRequestInnerSchema().parse(request)).toEqual(request)
    expect(
      SDKControlReadFileContentResponseSchema().parse({
        data: { type: 'image', file: { base64: 'abc' } },
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'abc',
            },
          },
        ],
        supplementalContent: ['metadata'],
        toolUseId: 'tool-1',
      }),
    ).toEqual({
      data: { type: 'image', file: { base64: 'abc' } },
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: 'abc',
          },
        },
      ],
      supplementalContent: ['metadata'],
      toolUseId: 'tool-1',
    })
  })
})
