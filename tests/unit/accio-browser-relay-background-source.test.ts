import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

function collectTopLevelAwaitNodes(sourceFile: ts.SourceFile): ts.AwaitExpression[] {
  const found: ts.AwaitExpression[] = []

  function visit(node: ts.Node, inFunctionScope: boolean): void {
    if (ts.isAwaitExpression(node) && !inFunctionScope) {
      found.push(node)
    }

    const nextInFunctionScope = inFunctionScope || ts.isFunctionLike(node)
    ts.forEachChild(node, (child) => visit(child, nextInFunctionScope))
  }

  visit(sourceFile, false)
  return found
}

describe('accio browser relay background source', () => {
  it('does not use top-level await in the MV3 service worker entry', async () => {
    const filePath = path.join(
      process.cwd(),
      'resources',
      'tools',
      'data',
      'extension',
      'chrome-extension',
      'accio-browser-relay',
      'background.js',
    )
    const sourceText = await readFile(filePath, 'utf8')
    const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)

    const topLevelAwaits = collectTopLevelAwaitNodes(sourceFile)

    expect(topLevelAwaits).toHaveLength(0)
  })
})
