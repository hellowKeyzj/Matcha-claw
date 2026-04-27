import fs from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { createBrowserRelayTool } from '../../packages/openclaw-browser-relay-plugin/src/application/browser-relay-tool'

const onePixelPngBase64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP2cAAAAASUVORK5CYII='

describe('browser relay tool', () => {
  it('exposes the final browser url parameter schema', () => {
    const tool = createBrowserRelayTool({}, () => ({
      handleRequest: async () => ({ ok: true }),
    }))

    expect(Object.keys(tool.parameters.properties)).toContain('url')
  })

  it('forwards session context to relay control', async () => {
    const handleRequest = vi.fn(async (params: Record<string, unknown>) => ({
      ok: true,
      echoed: params,
    }))

    const tool = createBrowserRelayTool(
      {
        sessionKey: 'agent:test',
        workspaceDir: 'E:/code/Matcha-claw',
      },
      () => ({ handleRequest }),
    )

    const result = await tool.execute('tool-call-1', {
      action: 'status',
    })

    expect(handleRequest).toHaveBeenCalledWith({
      action: 'status',
      sessionKey: 'agent:test',
      workspaceDir: 'E:/code/Matcha-claw',
    })
    expect(result.details).toMatchObject({
      ok: true,
      echoed: {
        action: 'status',
        sessionKey: 'agent:test',
        workspaceDir: 'E:/code/Matcha-claw',
      },
    })
  })

  it('wraps tabs output as browser external content', async () => {
    const tool = createBrowserRelayTool({}, () => ({
      handleRequest: async () => ({
        ok: true,
        tabs: [{ targetId: 'tab-1', title: 'Example', url: 'https://example.com' }],
      }),
    }))

    const result = await tool.execute('tool-call-2', { action: 'tabs' })

    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(result.content[0]?.text).toContain('"tabs"')
    expect(result.content[0]?.text).toContain('"targetId": "tab-1"')
    expect(result.details).toMatchObject({
      ok: true,
      tabCount: 1,
      externalContent: {
        untrusted: true,
        source: 'browser',
        kind: 'tabs',
        wrapped: true,
      },
    })
  })

  it('wraps snapshot output as browser snapshot external content', async () => {
    const tool = createBrowserRelayTool({}, () => ({
      handleRequest: async () => ({
        ok: true,
        targetId: 'tab-1',
        url: 'https://example.com',
        snapshot: 'button "Submit" [ref=e1]',
        refs: {
          e1: { role: 'button', name: 'Submit' },
        },
        stats: { lines: 1, chars: 24, refs: 1, interactive: 1 },
      }),
    }))

    const result = await tool.execute('tool-call-3', { action: 'snapshot' })

    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(result.content[0]?.text).toContain('button "Submit" [ref=e1]')
    expect(result.details).toMatchObject({
      ok: true,
      format: 'ai',
      targetId: 'tab-1',
      url: 'https://example.com',
      refs: 1,
      externalContent: {
        untrusted: true,
        source: 'browser',
        kind: 'snapshot',
        format: 'ai',
        wrapped: true,
      },
    })
  })

  it('returns screenshot output as image content', async () => {
    const tool = createBrowserRelayTool({}, () => ({
      handleRequest: async () => ({
        ok: true,
        targetId: 'tab-1',
        imageBase64: onePixelPngBase64,
        imageType: 'png',
      }),
    }))

    const result = await tool.execute('tool-call-4', { action: 'screenshot' })

    expect(result.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    })
    expect(result.details).toMatchObject({
      ok: true,
      targetId: 'tab-1',
    })
    expect(typeof result.details?.path).toBe('string')
    await expect(fs.access(String(result.details?.path))).resolves.toBeUndefined()
  })

  it('returns pdf output as a file reference', async () => {
    const tool = createBrowserRelayTool({}, () => ({
      handleRequest: async () => ({
        ok: true,
        targetId: 'tab-1',
        pdfBase64: Buffer.from('%PDF-1.4\n%%EOF', 'utf8').toString('base64'),
      }),
    }))

    const result = await tool.execute('tool-call-5', { action: 'pdf' })

    expect(result.content[0]).toMatchObject({ type: 'text' })
    expect(result.content[0]?.text).toContain('FILE:')
    expect(result.details).toMatchObject({
      ok: true,
      targetId: 'tab-1',
    })
    expect(typeof result.details?.path).toBe('string')
    await expect(fs.access(String(result.details?.path))).resolves.toBeUndefined()
  })
})
