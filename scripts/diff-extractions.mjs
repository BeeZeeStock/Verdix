#!/usr/bin/env node
/**
 * Usage:
 *   node scripts/diff-extractions.mjs /tmp/extraction_anthropic_*.json /tmp/extraction_bedrock_*.json
 *   node scripts/diff-extractions.mjs   ← auto-picks the two most recent files in /tmp
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

function findLatestLogs() {
  const files = readdirSync('/tmp')
    .filter(f => f.startsWith('extraction_') && f.endsWith('.json'))
    .map(f => ({ name: f, path: join('/tmp', f) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (files.length < 2) {
    console.error('Need at least 2 extraction log files in /tmp. Run with DEBUG_EXTRACTION=true first.')
    process.exit(1)
  }
  return [files[files.length - 2].path, files[files.length - 1].path]
}

const [pathA, pathB] = process.argv.slice(2).length === 2
  ? process.argv.slice(2)
  : findLatestLogs()

const a = JSON.parse(readFileSync(pathA, 'utf8'))
const b = JSON.parse(readFileSync(pathB, 'utf8'))

const pA = a.parsed
const pB = b.parsed

console.log(`\nComparing extractions:`)
console.log(`  A: ${a.provider}  (${a.timestamp})`)
console.log(`  B: ${b.provider}  (${b.timestamp})\n`)

const allKeys = new Set([...Object.keys(pA ?? {}), ...Object.keys(pB ?? {})])

let diffs = 0

for (const key of allKeys) {
  const vA = pA?.[key]
  const vB = pB?.[key]
  const sA = JSON.stringify(vA)
  const sB = JSON.stringify(vB)

  if (sA === sB) continue

  diffs++
  console.log(`─── ${key} ${'─'.repeat(Math.max(0, 50 - key.length))}`)

  if (typeof vA !== 'object' && typeof vB !== 'object') {
    // Scalar diff — show inline
    console.log(`  A: ${vA ?? 'null'}`)
    console.log(`  B: ${vB ?? 'null'}`)
    if (typeof vA === 'number' && typeof vB === 'number') {
      const delta = vB - vA
      const pct   = vA !== 0 ? ((delta / vA) * 100).toFixed(1) : 'n/a'
      console.log(`  Δ: ${delta > 0 ? '+' : ''}${delta}  (${pct}%)`)
    }
  } else {
    // Array / object diff — pretty print each
    console.log(`  A: ${JSON.stringify(vA, null, 4).split('\n').join('\n     ')}`)
    console.log(`  B: ${JSON.stringify(vB, null, 4).split('\n').join('\n     ')}`)
  }
  console.log()
}

if (diffs === 0) {
  console.log('✓ No differences found — both extractions are identical.')
} else {
  console.log(`Found ${diffs} field(s) with differences.`)
}
