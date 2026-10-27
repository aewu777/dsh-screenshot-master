// Build the plugin: compile TypeScript to ./lib and copy the PowerShell scripts
// that the Windows backend executes at runtime.
//
// The scripts are shipped as `.ps1` sources rather than being embedded in
// JavaScript so that they can be inspected, linted by the Windows integration
// tests, and reviewed by users who want to know exactly what runs on their
// machine.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lib = path.join(root, 'lib')

fs.rmSync(lib, { recursive: true, force: true })

execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(root, 'tsconfig.json')], {
  cwd: root,
  stdio: 'inherit',
})

const assets = path.join(root, 'src', 'platforms', 'scripts')
const target = path.join(lib, 'platforms', 'scripts')
if (fs.existsSync(assets)) {
  fs.cpSync(assets, target, { recursive: true })
}

const count = fs.existsSync(lib)
  ? fs.readdirSync(lib, { recursive: true }).filter((entry) => String(entry).endsWith('.js')).length
  : 0
console.log(`build: ok (${count} compiled modules) -> ${path.relative(root, lib)}`)
