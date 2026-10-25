#!/usr/bin/env node
// Runs the built viewer; from a checkout without a build, the sources directly.
import { existsSync } from 'node:fs'

const built = new URL('../lib/cli.js', import.meta.url)
await import(existsSync(built) ? built.href : new URL('../src/cli.ts', import.meta.url).href)
