/** Self-contained WeCom settings card contributed through `settings.plugin.item`. */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { FieldState } from './form.js'
import type { PresetOption, WeComCardFace, WorkspaceOption } from './controller.js'
import type { LocaleKey } from './locales.js'
import { styles } from './styles.js'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

export type WeComCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.wecom'>
  & InjectFace<WeComCardFace>

/** Field labels used when naming exactly which writes a deployment refused. */
const FIELD_LABELS: Readonly<Record<string, LocaleKey>> = {
  botId: 'botId',
  secret: 'secret',
  allowedUsers: 'allowedUsers',
  adminUsers: 'adminUsers',
  workspaceId: 'workspace',
  preventIdleSleep: 'preventIdleSleep',
  agentPreset: 'agentPreset',
  thinkingText: 'thinkingText',
  turnTimeoutMs: 'timeout',
}

interface ValueFieldProps {
  id: string
  label: string
  hint: string
  state: FieldState
  disabled: boolean
  numeric?: boolean
  invalidLabel: string
  overriddenLabel: string
  resetLabel: string
  onEdit(text: string): void
  onReset(): void
}

function ValueField(props: ValueFieldProps) {
  return (
    <div style={styles.field}>
      <div style={styles.fieldHead}>
        <label htmlFor={props.id} style={styles.label}>{props.label}</label>
        {props.state.overridden
          ? <><span style={styles.badge}>{props.overriddenLabel}</span><button type="button" style={styles.reset} disabled={props.disabled} onClick={props.onReset}>{props.resetLabel}</button></>
          : null}
      </div>
      <input
        id={props.id}
        type="text"
        style={{ ...styles.input, ...(props.state.invalid ? { borderColor: 'var(--dsw-alias-label-error)' } : {}) }}
        value={props.state.text}
        disabled={props.disabled}
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.state.invalid ? { 'aria-invalid': true } : {}}
        onChange={event => { props.onEdit(event.target.value) }}
      />
      <p style={props.state.invalid ? styles.error : styles.hint}>
        {props.state.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

function SecretField(props: {
  id: string
  label: string
  hint: string
  state: FieldState
  configured: boolean
  configuredLabel: string
  unconfiguredLabel: string
  disabled: boolean
  onEdit(text: string): void
}) {
  return (
    <div style={styles.field}>
      <div style={styles.fieldHead}>
        <label htmlFor={props.id} style={styles.label}>{props.label}</label>
        <span style={props.configured ? styles.badge : styles.mutedBadge}>
          {props.configured ? props.configuredLabel : props.unconfiguredLabel}
        </span>
      </div>
      <input
        id={props.id}
        type="password"
        autoComplete="off"
        style={styles.input}
        value={props.state.text}
        disabled={props.disabled}
        onChange={event => { props.onEdit(event.target.value) }}
      />
      <p style={styles.hint}>{props.hint}</p>
    </div>
  )
}

function PresetField(props: {
  state: FieldState
  options: readonly PresetOption[]
  loading: boolean
  failed: boolean
  disabled: boolean
  label: string
  hint: string
  inheritLabel: string
  loadingLabel: string
  failedLabel: string
  missingLabel: string
  unavailableLabel: string
  overriddenLabel: string
  resetLabel: string
  onEdit(value: string): void
  onReset(): void
}) {
  const selectedExists = props.state.text === ''
    || props.options.some(option => option.id === props.state.text)
  return (
    <div style={styles.field}>
      <div style={styles.fieldHead}>
        <label htmlFor="wecom-agent-preset" style={styles.label}>{props.label}</label>
        {props.state.overridden
          ? <><span style={styles.badge}>{props.overriddenLabel}</span><button type="button" style={styles.reset} disabled={props.disabled} onClick={props.onReset}>{props.resetLabel}</button></>
          : null}
      </div>
      <select
        id="wecom-agent-preset"
        style={styles.input}
        value={props.state.text}
        disabled={props.disabled || props.loading || props.failed}
        onChange={event => { props.onEdit(event.target.value) }}
      >
        <option value="">{props.loading
          ? props.loadingLabel
          : props.failed ? props.failedLabel : props.inheritLabel}</option>
        {!selectedExists ? <option value={props.state.text}>{props.missingLabel}</option> : null}
        {props.options.map(option => (
          <option key={option.id} value={option.id} disabled={option.broken !== undefined}>
            {option.name === undefined ? option.id : `${option.id}（${option.name}）`}
            {option.broken === undefined ? '' : ` [${props.unavailableLabel}: ${option.broken}]`}
          </option>
        ))}
      </select>
      <p style={styles.hint}>{props.failed ? props.failedLabel : props.hint}</p>
    </div>
  )
}

function WorkspaceField(props: {
  state: FieldState
  options: readonly WorkspaceOption[]
  loading: boolean
  failed: boolean
  disabled: boolean
  label: string
  hint: string
  defaultLabel: string
  loadingLabel: string
  failedLabel: string
  missingLabel: string
  overriddenLabel: string
  resetLabel: string
  onEdit(value: string): void
  onReset(): void
}) {
  const selectedExists = props.state.text === ''
    || props.options.some(option => option.id === props.state.text)
  return (
    <div style={styles.field}>
      <div style={styles.fieldHead}>
        <label htmlFor="wecom-workspace" style={styles.label}>{props.label}</label>
        {props.state.overridden
          ? <><span style={styles.badge}>{props.overriddenLabel}</span><button type="button" style={styles.reset} disabled={props.disabled} onClick={props.onReset}>{props.resetLabel}</button></>
          : null}
      </div>
      <select
        id="wecom-workspace"
        style={styles.input}
        value={props.state.text}
        disabled={props.disabled || props.loading}
        onChange={event => { props.onEdit(event.target.value) }}
      >
        <option value="">{props.loading
          ? props.loadingLabel
          : props.failed ? props.failedLabel : props.defaultLabel}</option>
        {!selectedExists ? <option value={props.state.text}>{props.missingLabel}</option> : null}
        {props.options.map(option => (
          <option key={option.id} value={option.id}>{option.title} — {option.path}</option>
        ))}
      </select>
      <p style={styles.hint}>{props.hint}</p>
    </div>
  )
}

/** Render the WeCom configuration contribution. */
export function WeComCard(props: WeComCardProps) {
  const state = props.useWeComCard(snapshot => snapshot)
  const t = (key: LocaleKey): string => props.t(key)
  const disabled = !state.writable
  const valueField = (
    field: 'allowedUsers' | 'adminUsers' | 'thinkingText' | 'turnTimeoutMs',
    id: string,
    label: LocaleKey,
    hint: LocaleKey,
    numeric = false,
  ) => (
    <ValueField
      id={id}
      label={t(label)}
      hint={t(hint)}
      state={state[field]}
      disabled={disabled}
      numeric={numeric}
      invalidLabel={t('invalid')}
      overriddenLabel={t('overridden')}
      resetLabel={t('reset')}
      onEdit={text => { props.edit(field, text) }}
      onReset={() => { props.resetField(field) }}
    />
  )
  return (
    <li style={styles.card}>
      <details>
        <summary style={styles.summary} aria-label={t('title')}>
          <span style={styles.heading}>
            <span style={styles.headText}>
              <span style={styles.title}>{t('title')}</span>
              <span style={styles.description}>{t('description')}</span>
            </span>
            {state.dirty ? <span style={styles.badge}>{t('unsaved')}</span> : null}
          </span>
        </summary>
        <div style={styles.body}>
          {!state.writable ? <p style={styles.hint}>{t('readOnly')}</p> : null}
          <SecretField id="wecom-bot-id" label={t('botId')} hint={t('botIdHint')} state={state.botId} configured={state.botIdConfigured} configuredLabel={t('configured')} unconfiguredLabel={t('unconfigured')} disabled={!state.botIdWritable} onEdit={text => { props.edit('botId', text) }} />
          <SecretField id="wecom-secret" label={t('secret')} hint={t('secretHint')} state={state.secret} configured={state.secretConfigured} configuredLabel={t('configured')} unconfiguredLabel={t('unconfigured')} disabled={!state.secretWritable} onEdit={text => { props.edit('secret', text) }} />
          {state.credentialFailure === undefined ? null : (
            <p style={styles.error}>
              {t(state.credentialFailure.message === undefined ? 'credentialUnconfirmed' : 'credentialRejected')}
              {` (${state.credentialFailure.ref})`}
              {state.credentialFailure.message === undefined ? '' : `: ${state.credentialFailure.message}`}
            </p>
          )}
          {valueField('allowedUsers', 'wecom-users', 'allowedUsers', 'allowedUsersHint')}
          {valueField('adminUsers', 'wecom-admin-users', 'adminUsers', 'adminUsersHint')}
          <p style={styles.hint}>{t('useridHint')}</p>
          <WorkspaceField
            state={state.workspaceId}
            options={state.workspaceOptions}
            loading={state.workspacesLoading}
            failed={state.workspacesFailed}
            disabled={disabled}
            label={t('workspace')}
            hint={t('workspaceHint')}
            defaultLabel={t('workspaceDefault')}
            loadingLabel={t('workspaceLoading')}
            failedLabel={t('workspaceLoadFailed')}
            missingLabel={t('workspaceMissing')}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            onEdit={value => { props.edit('workspaceId', value) }}
            onReset={() => { props.resetField('workspaceId') }}
          />
          <p style={styles.hint}>{t('commandsHint')}</p>
          <details style={styles.advanced}>
            <summary style={styles.advancedSummary}>{t('advanced')}</summary>
            <div style={styles.field}>
              <div style={styles.fieldHead}>
                <label htmlFor="wecom-prevent-idle-sleep" style={styles.label}>{t('preventIdleSleep')}</label>
                {state.preventIdleSleep.overridden ? <span style={styles.badge}>{t('overridden')}</span> : null}
              </div>
              <label htmlFor="wecom-prevent-idle-sleep" style={styles.toggle}>
                <input
                  id="wecom-prevent-idle-sleep"
                  type="checkbox"
                  checked={state.preventIdleSleep.text === 'true'}
                  disabled={disabled}
                  onChange={event => { props.edit('preventIdleSleep', event.target.checked ? 'true' : 'false') }}
                />
                <span>{state.preventIdleSleep.text === 'true' ? t('on') : t('off')}</span>
              </label>
              <p style={styles.hint}>{t('preventIdleSleepHint')}</p>
            </div>
            <PresetField
              state={state.agentPreset}
              options={state.presetOptions}
              loading={state.presetsLoading}
              failed={state.presetsFailed}
              disabled={disabled}
              label={t('agentPreset')}
              hint={t('agentPresetHint')}
              inheritLabel={state.presetDefaultId === undefined
                ? t('presetInherit')
                : `${t('presetInherit')}（${state.presetDefaultId}）`}
              loadingLabel={t('presetLoading')}
              failedLabel={t('presetLoadFailed')}
              missingLabel={t('presetMissing')}
              unavailableLabel={t('presetUnavailable')}
              overriddenLabel={t('overridden')}
              resetLabel={t('reset')}
              onEdit={value => { props.edit('agentPreset', value) }}
              onReset={() => { props.resetField('agentPreset') }}
            />
            {valueField('thinkingText', 'wecom-thinking-text', 'thinkingText', 'thinkingTextHint')}
            {valueField('turnTimeoutMs', 'wecom-timeout', 'timeout', 'timeoutHint', true)}
          </details>
          <div style={styles.footer}>
            {state.failed ? (
              <p style={{ ...styles.error, flex: 1 }}>
                {t('failed')}
                {state.rejected.length === 0 ? '' : ` ${t('rejectedFields')} ${state.rejected.map(field => {
                  const label = FIELD_LABELS[field]
                  return label === undefined ? field : t(label)
                }).join('、')}`}
              </p>
            ) : null}
            <button type="button" style={styles.button} disabled={!state.dirty || state.saving} onClick={props.discard}>{t('discard')}</button>
            <button type="button" style={styles.save} disabled={!state.dirty || state.invalid || state.saving} onClick={props.save}>{t(state.saving ? 'saving' : 'save')}</button>
          </div>
        </div>
      </details>
    </li>
  )
}
