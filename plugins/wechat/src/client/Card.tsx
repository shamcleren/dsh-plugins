import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PresetOption, WeChatCardFace, WeChatCardState } from './controller.js'
import type { LocaleKey } from './locales.js'
import { styles } from './styles.js'

export type WeChatCardProps = PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'settings.wechat'>
  & InjectFace<WeChatCardFace>

function PresetField(props: {
  state: WeChatCardState
  t(key: LocaleKey): string
  onEdit(id: string): void
  onSave(): void
  onDiscard(): void
}) {
  const { state, t } = props
  const selectedExists = state.presetText === ''
    || state.presetOptions.some(option => option.id === state.presetText)
  const inherit = state.presetDefaultId === undefined
    ? t('presetInherit')
    : `${t('presetInherit')}（${state.presetDefaultId}）`
  return (
    <section style={styles.field} aria-label={t('agentPreset')}>
      <div style={styles.fieldHead}>
        <label htmlFor="wechat-agent-preset" style={styles.label}>{t('agentPreset')}</label>
        {state.presetOverridden ? <span style={styles.badge}>{t('overridden')}</span> : null}
        {state.dirty ? <span style={styles.badge}>{t('unsaved')}</span> : null}
      </div>
      <select
        id="wechat-agent-preset"
        style={styles.input}
        value={state.presetText}
        disabled={!state.writable || state.presetsLoading || state.presetsFailed || state.saving}
        onChange={event => { props.onEdit(event.target.value) }}
      >
        <option value="">{state.presetsLoading ? t('presetLoading') : state.presetsFailed ? t('presetLoadFailed') : inherit}</option>
        {!selectedExists ? <option value={state.presetText}>{t('presetMissing')}</option> : null}
        {state.presetOptions.map((option: PresetOption) => (
          <option key={option.id} value={option.id} disabled={option.broken !== undefined}>
            {option.name === undefined ? option.id : `${option.id}（${option.name}）`}
            {option.broken === undefined ? '' : ` [${t('presetUnavailable')}: ${option.broken}]`}
          </option>
        ))}
      </select>
      <p style={styles.hint}>{state.presetsFailed ? t('presetLoadFailed') : t('agentPresetHint')}</p>
      {state.failed ? <p style={styles.error}>{state.failureMessage ?? t('saveFailed')}</p> : null}
      <div style={styles.loginActions}>
        <button type="button" style={styles.save} disabled={!state.dirty || state.saving} onClick={props.onSave}>
          {state.saving ? t('saving') : t('save')}
        </button>
        <button type="button" style={styles.button} disabled={!state.dirty || state.saving} onClick={props.onDiscard}>{t('discard')}</button>
      </div>
    </section>
  )
}

function LoginPanel(props: WeChatCardProps & { state: WeChatCardState }) {
  const { state } = props
  const login = state.login
  const t = (key: LocaleKey): string => props.t(key)
  const active = login.status === 'qr' || login.status === 'scanned' || login.status === 'verification-required'
  return (
    <section style={styles.field} aria-label={t('loginTitle')}>
      <div style={styles.fieldHead}>
        <span style={styles.label}>{t('loginTitle')}</span>
        <span style={login.accounts.length > 0 ? styles.badge : styles.mutedBadge}>
          {login.accounts.length > 0 ? t('connected') : t('notConnected')}
        </span>
      </div>
      {login.receiver ? <p role="status" style={login.receiver.status === 'failed' ? styles.error : styles.hint}>{t(('receiver_' + login.receiver.status) as LocaleKey)}</p> : null}
      {login.accounts.length > 0
        ? <p style={styles.hint}>{t('accounts')}: {login.accounts.length}</p>
        : null}
      {login.accounts.some(account => account.userId)
        ? <p style={styles.hint}>{t('automaticPermissions')}</p> : null}
      {'qrUrl' in login && state.qrDataUrl !== undefined
        ? <img src={state.qrDataUrl} width={240} height={240} alt={t('scanQr')} style={styles.qr} />
        : null}
      {state.qrRenderError !== undefined ? <p style={styles.error}>{t('qrRenderFailed')}: {state.qrRenderError}</p> : null}
      {'qrUrl' in login ? <a href={login.qrUrl} target="_blank" rel="noreferrer" style={styles.hint}>{t('openQrLink')}</a> : null}
      {login.status === 'qr' ? <p style={styles.hint}>{t('scanQr')}</p> : null}
      {login.status === 'scanned' ? <p style={styles.hint}>{t('confirmOnPhone')}</p> : null}
      {login.status === 'verification-required'
        ? <div style={styles.loginActions}>
            <input type="text" inputMode="numeric" autoComplete="one-time-code" style={styles.input}
              value={state.verificationCode} placeholder={t('verificationPlaceholder')}
              onChange={event => { props.setVerificationCode(event.target.value) }} />
            <button type="button" style={styles.save} disabled={state.verificationCode === '' || state.loginBusy}
              onClick={props.submitVerification}>{t('submitVerification')}</button>
          </div>
        : null}
      {login.status === 'complete' ? <p style={styles.hint}>{t('loginComplete')}</p> : null}
      {login.status === 'failed' ? <p style={styles.error}>{login.message}</p> : null}
      <div style={styles.loginActions}>
        {!active
          ? <button type="button" style={styles.button} disabled={state.loginBusy} onClick={props.beginLogin}>
              {login.accounts.length > 0 ? t('addAccount') : t('connectAccount')}
            </button>
          : <button type="button" style={styles.button} disabled={state.loginBusy} onClick={props.cancelLogin}>{t('cancelLogin')}</button>}
        <button type="button" style={styles.button} disabled={state.loginBusy} onClick={props.refreshLogin}>{t('refreshLogin')}</button>
      </div>
    </section>
  )
}

/** Render personal WeChat settings in the generic plugin section. */
export function WeChatCard(props: WeChatCardProps) {
  const state = props.useWeChatCard(snapshot => snapshot)
  const t = (key: LocaleKey): string => props.t(key)
  return (
    <section style={styles.card}>
      <details>
        <summary style={styles.summary} aria-label={t('title')}>
          <span style={styles.heading}>
            <span style={styles.headText}><span style={styles.title}>{t('title')}</span><span style={styles.description}>{t('description')}</span></span>
          </span>
        </summary>
        <div style={styles.body}>
          <LoginPanel {...props} state={state} />
          <p style={styles.hint}>{t('automaticReception')}</p>
          <p style={styles.hint}>{t('commandsHint')}</p>
          <PresetField state={state} t={t} onEdit={props.editPreset} onSave={props.savePreset} onDiscard={props.discardPreset} />
        </div>
      </details>
    </section>
  )
}
