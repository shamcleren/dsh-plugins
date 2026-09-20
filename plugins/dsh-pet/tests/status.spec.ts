import { describe, expect, it } from 'vitest'
import { groupOf, toolActivity } from '../src/status.js'

describe('toolActivity', () => {
  it('classifies search/read tools as searching', () => {
    expect(toolActivity('read_file')).toBe('searching')
    expect(toolActivity('grep_search')).toBe('searching')
    expect(toolActivity('web_search')).toBe('searching')
  })

  it('classifies write/edit tools as editing', () => {
    expect(toolActivity('write_file')).toBe('editing')
    expect(toolActivity('edit_file')).toBe('editing')
    expect(toolActivity('bash_create')).toBe('editing')
  })

  it('classifies test/build tools as testing', () => {
    expect(toolActivity('run_tests')).toBe('testing')
    expect(toolActivity('verify_build')).toBe('testing')
  })

  it('classifies shell/exec tools as commanding', () => {
    expect(toolActivity('bash')).toBe('commanding')
    expect(toolActivity('exec_command')).toBe('commanding')
  })

  it('falls back to using-tool', () => {
    expect(toolActivity('send_qiwei_message')).toBe('using-tool')
  })
})

describe('groupOf', () => {
  it('maps each activity to its copy group', () => {
    expect(groupOf('searching')).toBe('searching')
    expect(groupOf('editing')).toBe('editing')
    expect(groupOf('testing')).toBe('testing')
    expect(groupOf('commanding')).toBe('commanding')
    expect(groupOf('using-tool')).toBe('working')
  })
})
