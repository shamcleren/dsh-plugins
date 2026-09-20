/** Self-contained desktop-pet settings card contributed through `settings.plugin.item`. */

import type { CSSProperties } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PetPickerItem } from '../shared/picker.js'
import type { DesktopPetCardFace } from './controller.js'
import type { LocaleKey } from './locales.js'
import { styles } from './styles.js'

export type DesktopPetCardProps = PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.desktop-pet'> & InjectFace<DesktopPetCardFace>

/** Fixed thumbnail cell width; height follows the pack's cell aspect. */
const THUMB_CELL_WIDTH = 48

function thumbImageStyle(pet: PetPickerItem): CSSProperties {
  const scale = THUMB_CELL_WIDTH / pet.cellWidth
  return {
    display: 'block',
    width: THUMB_CELL_WIDTH,
    height: Math.round(pet.cellHeight * scale),
    backgroundImage: `url(${pet.spriteUrl})`,
    backgroundSize: `${Math.round(pet.spriteWidth * scale)}px auto`,
    backgroundPosition: '0 0',
    backgroundRepeat: 'no-repeat',
  }
}

export function DesktopPetCard(props: DesktopPetCardProps) {
  const state = props.useDesktopPetCard(snapshot => snapshot)
  const t = (key: LocaleKey): string => props.t(key)
  const disabled = !state.writable || !state.available

  const commitOnEnter = (key: string, commit: () => void) => (event: { key: string }) => {
    if (event.key === 'Enter') commit()
  }

  return <li style={styles.card}>
    <details>
      <summary style={styles.summary}>
        <span style={styles.heading}>
          <span style={styles.headText}>
            <span style={styles.title}>{t('title')}</span>
            <span style={styles.description}>{t('description')}</span>
          </span>
        </span>
      </summary>
      <div style={styles.body}>
        {!state.writable ? <p style={styles.hint}>{t('readOnly')}</p> : null}
        <div style={styles.field}>
          <div style={styles.fieldHead}><label htmlFor="desktop-pet-enabled" style={styles.label}>{t('enabled')}</label></div>
          <label htmlFor="desktop-pet-enabled" style={styles.toggle}>
            <input id="desktop-pet-enabled" type="checkbox" checked={state.enabled} disabled={disabled} onChange={event => { props.setEnabled(event.target.checked) }} />
            <span>{state.enabled ? t('on') : t('off')}</span>
          </label>
          <p style={styles.hint}>{t('enabledHint')}</p>
        </div>
        <div style={styles.field}>
          <span style={styles.label}>{t('pet')}</span>
          {state.petsLoading ? <p style={styles.hint}>{t('petsLoading')}</p> : null}
          {state.petsFailed ? <p style={styles.hint}>{t('petsError')}</p> : null}
          {!state.petsLoading && !state.petsFailed && state.pets.length === 0 ? <p style={styles.hint}>{t('petsEmpty')}</p> : null}
          <div style={styles.grid}>
            {state.pets.map(pet => {
              const selected = state.petId === pet.id
              return <button key={pet.id} type="button" disabled={disabled}
                onClick={() => { props.selectPet(pet.id) }}
                aria-pressed={selected} title={pet.displayName}
                style={selected ? { ...styles.thumb, ...styles.thumbSelected } : styles.thumb}>
                <span style={thumbImageStyle(pet)} />
                <span style={styles.thumbName}>{pet.displayName}</span>
              </button>
            })}
          </div>
          <p style={styles.hint}>{t('petHint')}</p>
        </div>
        <div style={styles.field}>
          <label htmlFor="desktop-pet-pet-size" style={styles.label}>{t('petSize')}</label>
          <input id="desktop-pet-pet-size" type="text" inputMode="numeric" style={styles.input} value={state.petSizeDraft} disabled={disabled}
            onChange={event => { props.editPetSize(event.target.value) }}
            onBlur={() => { props.commitPetSize() }}
            onKeyDown={commitOnEnter('Enter', () => { props.commitPetSize() })} />
          <p style={styles.hint}>{t('petSizeHint')}</p>
        </div>
      </div>
    </details>
  </li>
}
