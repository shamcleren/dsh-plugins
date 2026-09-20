import assert from 'node:assert/strict'
import test from 'node:test'
import { buildOptions, dshHomePlistEntry } from '../build-options.mjs'

test('managed apps have stable distinct identities, separate from standalone apps', () => {
  const first = buildOptions('/example/clean', {})
  assert.deepEqual(buildOptions('/example/clean', {}), first)
  assert.notEqual(first.bundleIdentifier, buildOptions('/example/existing', {}).bundleIdentifier)
  assert.notEqual(first.bundleIdentifier, buildOptions(undefined, {}).bundleIdentifier)
  assert.equal(first.servicePort, 3080)
})

test('parallel installations can choose another port and invalid ports fail before building', () => {
  assert.equal(buildOptions('/example/clean', { DSH_APP_PORT: '3082' }).servicePort, 3082)
  for (const value of ['0', '-1', '65536', '3080junk', '3.5', '', ' 3080']) {
    assert.throws(() => buildOptions('/example/clean', { DSH_APP_PORT: value }), /DSH_APP_PORT/)
  }
})

test('standalone apps leave the home unset; managed apps escape the recorded path in XML', () => {
  assert.equal(dshHomePlistEntry(undefined), '')
  assert.equal(dshHomePlistEntry('/users/A & B/.dsh'), '<key>DSHHome</key><string>/users/A &amp; B/.dsh</string>')
})
