import { acquireInstallerLock } from '../installer-lock.mjs'

const command = () => new Promise(resolve => process.once('message', resolve))
let next = command()
process.send('ready')
await next
let unlock
try { unlock = await acquireInstallerLock(process.argv[2]) }
catch (error) {
  if (!/Another installer/.test(error.message)) throw error
  process.send('blocked', () => process.disconnect())
}
if (unlock) {
  next = command()
  process.send('locked')
  try { await next } finally { await unlock(); process.disconnect() }
}
