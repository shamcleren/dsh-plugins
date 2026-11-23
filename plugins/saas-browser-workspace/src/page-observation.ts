import type { Site, ExecutionRule } from './site.js'
import type { PageDocument, PageBlock, PageField } from './agent-contract.js'

/** Runs in the page's main frame. Read only DOM/ARIA, with shared masking and bounded output. */
export function observePage({ selectors, readLabels, rule, emptyText, masks }: {
  selectors: Site['selectors']; readLabels: string[]; rule: ExecutionRule | undefined; emptyText: string; masks: string[]
}) {

      const visible = (el: Element) => {
        if (!el.getClientRects().length) return false
        for (let current: Element | null = el; current; current = current.parentElement) {
          const style = getComputedStyle(current)
          if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        }
        return true
      }
      const text = (el: Element | null, limit = 1000) => ((el instanceof HTMLElement ? el.innerText : el?.textContent) ?? '').trim().slice(0, limit)
      const sensitive = /password|secret|token|api.?key|验证码|密码|密钥/i
      const address = (el: Element): string => {
        const parts: string[] = []; let current: Element | null = el
        while (current && current !== document.documentElement) {
          const element: Element = current, parent: Element | null = element.parentElement
          const siblings = parent ? Array.from(parent.children).filter(e => e.tagName === element.tagName) : [element]
          parts.unshift(element.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')'); current = parent
        }
        return 'html>' + parts.join('>')
      }
      const scope = rule ? document.querySelector(rule.scope) : null
      const allElements = Array.from(document.querySelectorAll('input:not([type=hidden]),textarea,select,[contenteditable=true],button,[role=button],a,[role=tab],[role=switch],[role=checkbox],[role=radio],[role=combobox],[role=textbox]')).filter(visible)
      const masked = Array.from(document.querySelectorAll(masks.join(',') || ':not(*)'))
      const inMask = (el: Element) => masked.some(root => root === el || root.contains(el))
      const labelledBy = (el: Element) => (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)).filter((node): node is HTMLElement => !!node && !inMask(node) && visible(node)).map(node => text(node, 200)).join(' ').trim()
      const labelOf = (el: Element) => el.getAttribute('aria-label') || labelledBy(el) || el.getAttribute('aria-placeholder') || (el as HTMLInputElement).labels?.[0]?.textContent?.trim() || text(el, 200) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.tagName.toLowerCase()
      const hiddenField = (el: Element) => inMask(el) || (el as HTMLInputElement).type === 'password' || sensitive.test(labelOf(el) + ' ' + el.getAttribute('name') + ' ' + el.id + ' ' + (el as HTMLInputElement).autocomplete)
      const redacted = new Set([...allElements.filter(hiddenField), ...masked])
      for (const term of document.querySelectorAll('dt')) if (sensitive.test(text(term, 200)) && term.nextElementSibling?.tagName === 'DD') redacted.add(term.nextElementSibling)
      const safeText = (root: Node, limit: number) => {
        let remaining = limit, visited = 0
        const collect = (node: Node): string => {
          if (remaining <= 0 || ++visited > 20000) return ''
          if (node instanceof Element && (redacted.has(node) || inMask(node) || node.matches('script,style,noscript,template') || !visible(node))) return ''
          if (node.nodeType === Node.TEXT_NODE) { const value = (node.textContent ?? '').slice(0, remaining); remaining -= value.length; return value }
          return Array.from(node.childNodes).map(collect).join(node instanceof Element && /^(DIV|P|SECTION|ARTICLE|LI|BR|H[1-6])$/.test(node.tagName) ? '\n' : '')
        }
        return collect(root).trim().slice(0, limit)
      }
      const fieldText = (el: Element | null, limit: number) => el && !inMask(el) ? safeText(el, limit) : ''
      const elements = allElements.slice(0, 160)
      if (rule && scope) for (const el of scope.querySelectorAll(rule.submit)) if (visible(el) && !elements.includes(el)) elements.push(el)
      const controls = elements.map((el, index) => {
        const input = el as HTMLInputElement
        const hidden = hiddenField(el)
        const label = hidden ? '[hidden field]' : labelOf(el)
        const choice = input.type === 'radio' || input.type === 'checkbox'
        const value = hidden ? '[hidden]' : choice ? (input.checked ? label : '')
          : el instanceof HTMLSelectElement ? Array.from(el.selectedOptions).map(option => option.text).join(', ')
          : ('value' in el ? String(input.value).slice(0, 3000) : el.matches('[contenteditable=true]') ? text(el, 3000) : '')
        const denied = /保存|发布|删除|分享|权限|上传|下载|save|publish|delete|share|permission|upload|download/i.test(label)
        const message = !!rule && !!scope?.contains(el) && el.matches(rule.input) && !hidden && !denied && !input.disabled && !input.readOnly
        const submit = !!rule && !!scope?.contains(el) && el.matches(rule.submit) && !hidden && !denied
        const search = el.matches(selectors.search) && !hidden && !denied && !input.disabled && !input.readOnly
        const navigation = readLabels.includes(label.replace(/[\s\uE000-\uF8FF]/g, '')) && !input.disabled && !denied
        return { ref: 'e' + index, selector: address(el), label, role: el.getAttribute('role') || el.tagName.toLowerCase(), value,
          canFill: message || search, canClick: navigation, sensitive: hidden,
          purpose: message ? 'message' as const : submit ? 'submit' as const : search ? 'search' as const : navigation ? 'navigation' as const : 'readonly' as const }
      })
      const cards = Array.from(document.querySelectorAll(selectors.card)).filter(visible)
      const records = cards.slice(0, 50).map((card, index) => ({ id: 'r' + index,
        name: fieldText(card.querySelector(selectors.name), 500), type: fieldText(card.querySelector(selectors.type), 200), version: fieldText(card.querySelector(selectors.version), 200),
        description: fieldText(card.querySelector(selectors.description), 2000), tags: Array.from(card.querySelectorAll(selectors.tags)).filter(visible).map(el => fieldText(el, 200)).slice(0, 20),
        actions: controls.filter((control, i) => card.contains(elements[i]!) && control.canClick).map(({ ref, label }) => ({ ref, label })),
      })).filter(row => row.name)
      function readDocument(): PageDocument {
        const root = Array.from(document.querySelectorAll('dialog[open],[role=dialog][aria-modal=true]')).filter(visible).at(-1) ?? document.querySelector('main,[role=main]') ?? document.body
        const blocks: PageBlock[] = [], gaps: PageDocument['gaps'] = []
        let remaining = 24000, truncated = false, heading = ''
        const covered = new Set<Element>()
        const fieldSelector = 'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]):not([type=image]),textarea,select,[contenteditable=true],[role=textbox],[role=combobox],[role=switch],[role=checkbox],[role=radio],[role=spinbutton]'
        const editorSelector = '.monaco-editor,.cm-editor,.CodeMirror,[role=application]'
        const name = (el: Element) => {
          const explicit = el.getAttribute('aria-label') || labelledBy(el)
          if (explicit) return explicit.slice(0, 200)
          const label = (el as HTMLInputElement).labels?.[0]
          return (label ? fieldText(label, 200) : '') || el.getAttribute('title') || el.getAttribute('name') || ''
        }
        const take = (value: string, limit = 3000) => {
          const count = Math.min(remaining, limit)
          if (value.length > count) truncated = true
          const result = value.slice(0, count); remaining -= result.length
          return result
        }
        const read = (el: Element, limit = 3000) => take(fieldText(el, limit + 1), limit)
        const gap = (kind: PageDocument['gaps'][number]['kind'], label: string) => {
          if (gaps.some(item => item.kind === kind && item.label === label)) return
          if (gaps.length < 24) gaps.push({ kind, label: take(label, 200) }); else truncated = true
        }
        const titleOf = (el: Element) => {
          const group = el.closest('fieldset,section,article,form,[role=region],[role=group]')
          const title = group && group !== root ? name(group) || fieldText(group.querySelector(':scope > legend,:scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > header'), 200) : ''
          return title || heading
        }
        const addField = (title: string, field: PageField) => {
          const last = blocks.at(-1)
          if (last?.kind === 'fields' && last.title === title && last.fields.length < 24) last.fields.push(field)
          else blocks.push({ kind: 'fields', title, fields: [field] })
        }
        const nodes = Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,blockquote,pre,table,[role=table],[role=grid],ul,ol,[role=list],dl,details,[aria-expanded=false],canvas,svg,iframe,img,[role=img],' + editorSelector + ',' + fieldSelector))
        for (const el of nodes.slice(0, 2000)) {
          if (blocks.length >= 60 || remaining <= 0) { truncated = true; break }
          if (!visible(el) || inMask(el) || [...covered].some(parent => parent.contains(el))) continue
          // Framework editor DOM may contain only the rendered lines. Never claim it is the whole value.
          if (el.matches(editorSelector)) { gap('editor', name(el) || titleOf(el)); covered.add(el); continue }
          if (el.shadowRoot) { gap('embedded', name(el) || titleOf(el)); covered.add(el); continue }
          if (/^H[1-6]$/.test(el.tagName)) { heading = read(el, 200); continue }
          if (el.matches('iframe')) { gap('embedded', name(el)); continue }
          if (el.matches('canvas,svg,img,[role=img]')) {
            // Ignore small decorative icons. Charts and images remain available in the original page.
            const rect = el.getBoundingClientRect()
            if (rect.width >= 100 && rect.height >= 60) gap('graphic', name(el) || el.getAttribute('alt') || titleOf(el))
            covered.add(el); continue
          }
          if (el.matches('details:not([open]),[aria-expanded=false]') && !el.matches('[role=combobox]')) {
            gap('collapsed', name(el) || fieldText(el.querySelector('summary'), 200) || read(el, 200))
            if (el.tagName === 'DETAILS') covered.add(el)
            continue
          }
          if (el.matches(fieldSelector)) {
            // A composite widget owns its nested input; display one field, never its options as values.
            if (el.parentElement?.closest('[role=combobox],[role=textbox],[contenteditable=true]')) continue
            const input = el as HTMLInputElement, label = name(el)
            const hidden = hiddenField(el) || sensitive.test(label)
            const toggle = el.matches('input[type=checkbox],input[type=radio],[role=switch],[role=checkbox],[role=radio]')
            const kind: PageField['kind'] = toggle ? (input.type === 'radio' || el.getAttribute('role') === 'radio' ? 'choice' : 'toggle') : el.matches('select,[role=combobox]') ? 'choice' : el.matches('textarea,[contenteditable=true]') ? 'multiline' : input.type === 'number' || el.getAttribute('role') === 'spinbutton' ? 'number' : 'text'
            let state: PageField['state'] = 'unread', value = '', checked: PageField['checked']
            if (hidden) state = 'redacted'
            else if (toggle) {
              checked = el instanceof HTMLInputElement ? (input.indeterminate ? 'mixed' : input.checked ? 'on' : 'off') : el.getAttribute('aria-checked') === 'mixed' ? 'mixed' : el.getAttribute('aria-checked') === 'true' ? 'on' : el.getAttribute('aria-checked') === 'false' ? 'off' : undefined
              state = checked ? 'value' : 'unread'
            } else if (el instanceof HTMLSelectElement) { value = Array.from(el.selectedOptions).filter(option => option.value && !inMask(option)).map(option => option.label).join(', '); state = value ? 'value' : 'empty' }
            else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
              if (input.type !== 'file') { value = input.value; state = value ? 'value' : 'empty' }
            } else if (el.matches('[contenteditable=true]')) { value = fieldText(el, 3001); state = value ? 'value' : 'empty' }
            else {
              const selected = el.querySelector('[aria-selected=true]')
              value = el.getAttribute('aria-valuetext') || (selected ? fieldText(selected, 3001) : el.matches('[role=combobox]') && !el.querySelector('[role=option]') ? fieldText(el, 3001) : '')
              if (value && value !== el.getAttribute('data-placeholder') && value !== el.getAttribute('aria-placeholder')) state = 'value'
              else value = ''
            }
            addField(take(titleOf(el), 200), { label: hidden ? '' : take(label, 200), kind, state, value: take(value), ...(checked ? { checked } : {}) })
            if (state === 'unread') gap('unread', label || titleOf(el))
            covered.add(el); continue
          }
          if (el.matches('table,[role=table],[role=grid]')) {
            const rows = Array.from(el.querySelectorAll('tr,[role=row]')).filter(row => visible(row) && row.closest('table,[role=table],[role=grid]') === el)
            if (rows.length > 21 || el.querySelector('[rowspan]:not([rowspan="1"]),[colspan]:not([colspan="1"])') || Number(el.getAttribute('aria-rowcount')) > rows.length) gap('limit', name(el) || titleOf(el))
            let columns: string[] = []; const values: string[][] = []
            for (const row of rows.slice(0, 21)) {
              const cells = Array.from(row.querySelectorAll('th,td,[role=cell],[role=columnheader],[role=rowheader],[role=gridcell]')).filter(cell => visible(cell) && cell.closest('tr,[role=row]') === row)
              if (cells.length > 12) truncated = true
              const content = cells.slice(0, 12).map(cell => read(cell, 500))
              if (!values.length && !columns.length && cells.length && cells.every(cell => cell.matches('th,[role=columnheader]'))) columns = content
              else if (content.length) values.push(content)
            }
            if (columns.length || values.length) blocks.push({ kind: 'table', title: take(name(el) || fieldText(el.querySelector('caption'), 200) || titleOf(el), 200), columns, rows: values })
            else gap('unread', name(el) || titleOf(el))
            covered.add(el); continue
          }
          if (el.matches('ul,ol,[role=list]')) {
            if (el.closest('nav,[role=navigation]')) continue
            const items = Array.from(el.querySelectorAll('li,[role=listitem]')).filter(item => visible(item) && item.closest('ul,ol,[role=list]') === el)
            if (items.length > 20) truncated = true
            const values = items.slice(0, 20).map(item => read(item, 1000)).filter(Boolean)
            if (values.length && !el.querySelector(fieldSelector)) blocks.push({ kind: 'list', title: take(name(el) || titleOf(el), 200), items: values })
            // Interactive lists are read as fields instead of flattening and duplicating them.
            if (!el.querySelector(fieldSelector)) covered.add(el)
            continue
          }
          if (el.matches('dl')) {
            for (const term of Array.from(el.querySelectorAll('dt')).slice(0, 24)) {
              const value = term.nextElementSibling
              if (visible(term) && value?.tagName === 'DD' && visible(value)) {
                const label = fieldText(term, 200), hidden = sensitive.test(label) || inMask(value)
                const content = hidden ? '' : read(value)
                addField(take(titleOf(el), 200), { label: hidden ? '' : label, kind: 'text', state: hidden ? 'redacted' : content ? 'value' : 'empty', value: content })
              }
            }
            covered.add(el); continue
          }
          if (el.matches('p,blockquote,pre') && !el.closest('nav,[role=navigation],label') && !el.querySelector(fieldSelector)) {
            const content = read(el, 3000)
            if (content) blocks.push({ kind: 'text', title: take(titleOf(el), 200), text: content })
            covered.add(el)
          }
        }
        if (nodes.length > 2000) truncated = true
        // Custom elements with inaccessible semantics and pages with only generic divs use the image fallback.
        if (Array.from(root.querySelectorAll('*')).slice(0, 3000).some(el => el.shadowRoot && visible(el) && !inMask(el))) gap('embedded', '')
        const unclassified = Array.from(root.querySelectorAll('div,span')).slice(0, 3000).find(el => !el.children.length && visible(el) && !inMask(el)
          && !el.closest('nav,header,footer,label,button,a,[role=button],[role=tab],[role=navigation],[aria-labelledby]')
          && ![...covered].some(parent => parent.contains(el)) && fieldText(el, 100).length > 2)
        if (!blocks.length || unclassified) gap('unstructured', unclassified ? titleOf(unclassified) : '')
        if (truncated) gap('limit', '')
        return { blocks, gaps, truncated }
      }
      const raw = safeText(document.querySelector('main,[role=main]') ?? document.body, 16000)
      const resultRoot = document.querySelector(selectors.results)
      const recordsState = records.length ? 'ready' as const : resultRoot && visible(resultRoot) ? (text(resultRoot, 16000).includes(emptyText) ? 'empty' as const : 'loading' as const) : 'unavailable' as const
      return { title: document.title.slice(0, 300), text: raw, controls, records, recordsState, document: readDocument(), truncated: cards.length > 50 || raw.length >= 16000 }

}
