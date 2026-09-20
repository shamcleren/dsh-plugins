import { dirname, join } from 'node:path'
import { bootstrap } from '../bootstrap.mjs'

let release
const gate = new Promise(resolve => { release = resolve })
process.once('message', () => release())
let announced = false
await bootstrap({ directory: process.argv[2], repo: process.argv[3], dshHome: process.argv[4],
  userHome: join(dirname(process.argv[2]), 'command-user'), desktop: false, log() {}, execute: async () => {
  if (!announced) { announced = true; process.send('locked') }
  await gate
} })
process.disconnect()
