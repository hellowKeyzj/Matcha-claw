import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'

// Test-only observation of the real CLI; bytes sent to Rust are unchanged.
const cli = path.resolve(process.argv[2])
const root = process.env.MATCHA_TEST_ROOT
const rawFile = path.join(root, 'raw', `${process.pid}.ndjson`)
const key = process.env.MATCHA_TEST_KEY
const decoder = new StringDecoder('utf8')
let pending = ''

fs.appendFileSync(
  path.join(root, 'children.jsonl'),
  `${JSON.stringify({ pid: process.pid, cwd: process.cwd() })}\n`,
)

function capture(text) {
  pending += text
  const end = pending.lastIndexOf('\n')
  if (end < 0) return
  const lines = pending.slice(0, end + 1)
  fs.appendFileSync(rawFile, key ? lines.replaceAll(key, '[REDACTED]') : lines)
  pending = pending.slice(end + 1)
}

const write = process.stdout.write.bind(process.stdout)
process.stdout.write = function (chunk, ...args) {
  capture(typeof chunk === 'string' ? chunk : decoder.write(chunk))
  return write(chunk, ...args)
}
process.on('exit', () => {
  pending += decoder.end()
  if (pending) {
    fs.appendFileSync(
      rawFile,
      key ? pending.replaceAll(key, '[REDACTED]') : pending,
    )
  }
})

process.argv = [process.argv[0], cli, ...process.argv.slice(3)]
await import(pathToFileURL(cli).href)
