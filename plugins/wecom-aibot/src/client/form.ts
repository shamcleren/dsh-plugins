/** Staged settings and credential writes for the WeCom browser card. */

import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
type SnapshotStore<T> = { getSnapshot(): T; subscribe(listener: () => void): () => void; set(value: T): void; update(mutator: (value: T) => void): void }

export interface FieldState {
  text: string
  overridden: boolean
  invalid: boolean
}

export interface FormState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  /** Fields the deployment did not accept during the last save attempt. */
  rejected: readonly string[]
}

export interface FormActions {
  edit(field: string, text: string): void
  resetField(field: string): void
  save(): void
  discard(): void
}

type FieldWrite = { kind: 'set'; value: unknown } | { kind: 'clear' }

interface FieldSpec {
  field: string
  format(value: unknown): string
  parse(text: string): FieldWrite | undefined
}

interface SecretSpec {
  field: string
  write(text: string): Promise<boolean>
}

interface StagedEdit {
  text: string
  clear: boolean
}

interface PlannedWrite {
  field: string
  run: (() => Promise<boolean>) | undefined
}

export function booleanField(field: string): FieldSpec {
  return {
    field,
    format: value => value === true ? 'true' : 'false',
    parse: text => text === 'true' || text === 'false'
      ? { kind: 'set', value: text === 'true' }
      : undefined,
  }
}

export function numberField(field: string): FieldSpec {
  return {
    field,
    format: value => typeof value === 'number' ? String(value) : '',
    parse: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const parsed = Number(trimmed)
      return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : undefined
    },
  }
}

export function textField(field: string): FieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

export function stringListField(field: string): FieldSpec {
  return {
    field,
    format: value => Array.isArray(value)
      ? value.filter(entry => typeof entry === 'string').join(', ')
      : '',
    parse: (text) => {
      const values = text.split(/[\n,]/u).map(value => value.trim()).filter(Boolean)
      return values.length === 0 ? { kind: 'clear' } : { kind: 'set', value: values }
    },
  }
}

/** Owns drafts over one settings namespace and writes them only on Save. */
export class CardForm<T> {
  private readonly fields: Map<string, FieldSpec>
  private readonly secrets: Map<string, SecretSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false
  private rejected: readonly string[] = []

  constructor(
    private readonly scope: SettingsScope<T>,
    fields: FieldSpec[],
    secrets: SecretSpec[],
  ) {
    this.fields = new Map(fields.map(field => [field.field, field]))
    this.secrets = new Map(secrets.map(secret => [secret.field, secret]))
    scope.subscribe(() => { this.publish() })
  }

  bind<S>(project: () => S): SnapshotStore<S> {
    const store = createStore(project())
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  state(): FormState {
    const plan = this.plan()
    const snapshot = this.scope.getSnapshot()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(write => write.run === undefined),
      saving: this.saving,
      failed: this.failed,
      rejected: this.rejected,
    }
  }

  field(field: string): FieldState {
    const staged = this.staged.get(field)
    if (this.secrets.has(field)) {
      return { text: staged?.text ?? '', overridden: false, invalid: false }
    }
    const spec = this.spec(field)
    if (staged === undefined) {
      return {
        text: spec.format(this.sectionValue(field)),
        overridden: this.stored(field),
        invalid: false,
      }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return { text: staged.text, overridden: write?.kind === 'set', invalid: write === undefined }
  }

  actions(): FormActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        this.staged.clear()
        this.failed = false
        this.rejected = []
        this.publish()
      },
    }
  }

  private async save(): Promise<void> {
    const plan = this.plan()
    if (plan.length === 0 || this.saving || plan.some(write => write.run === undefined)) return
    this.saving = true
    this.failed = false
    this.rejected = []
    this.publish()
    const rejected: string[] = []
    for (const write of plan) {
      if (write.run !== undefined && !await write.run()) rejected.push(write.field)
    }
    if (rejected.length === 0) this.staged.clear()
    this.saving = false
    this.failed = rejected.length > 0
    this.rejected = rejected
    this.publish()
  }

  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const secret = this.secrets.get(field)
      if (secret !== undefined) {
        const value = staged.text.trim()
        if (value !== '') plan.push({ field, run: () => secret.write(value) })
        continue
      }
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, run: undefined })
      else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
      else plan.push({ field, run: () => this.store(field, write.value) })
    }
    return plan
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return equalSettingValue(this.userLayer()?.[field], value)
  }

  private stage(field: string, edit: StagedEdit): void {
    if (!this.secrets.has(field)) this.spec(field)
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private spec(field: string): FieldSpec {
    const spec = this.fields.get(field)
    if (spec === undefined) throw new Error(`wecom card has no field ${field}`)
    return spec
  }

  private sectionValue(field: string): unknown {
    return (this.scope.getSnapshot().value as Record<string, unknown> | undefined)?.[field]
  }

  private baseValue(field: string): unknown {
    return (this.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.scope.getSnapshot().user as Record<string, unknown> | undefined
  }

  private stored(field: string): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}

function createStore<S>(initial: S): SnapshotStore<S> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      snapshot = next
      for (const listener of listeners) listener()
    },
    update(mutator) {
      const next = structuredClone(snapshot)
      mutator(next)
      snapshot = next
      for (const listener of listeners) listener()
    },
  }
}

function equalSettingValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => equalSettingValue(entry, right[index]))
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  return keys.length === Object.keys(rightRecord).length
    && keys.every(key => Object.hasOwn(rightRecord, key) && equalSettingValue(leftRecord[key], rightRecord[key]))
}
