export const styles = `
.ghw {
  --ghw-accent: #4774e8;
  --ghw-line: color-mix(in srgb, currentColor 14%, transparent);
  --ghw-muted: color-mix(in srgb, currentColor 58%, transparent);
  --ghw-surface: color-mix(in srgb, currentColor 3%, transparent);
  --ghw-control-height: 40px;
  --ghw-radius: 8px;
  /* Inline-size containment and auto margins need an explicit width in the host slot. */
  container: ghw / inline-size;
  inline-size: 100%;
  max-width: 1180px;
  min-width: 0;
  margin: 0 auto;
  padding: 24px clamp(16px, 2.5vw, 26px) 32px;
  box-sizing: border-box;
  color: inherit;
  font-size: 13px;
  line-height: 1.55;
}
.ghw *, .ghw *::before, .ghw *::after { box-sizing: border-box; }
.ghw h2, .ghw h3, .ghw h4, .ghw p { margin: 0; }
.ghw h2 { font-size: 21px; line-height: 1.3; letter-spacing: -.4px; font-weight: 650; }
.ghw h3 { font-size: 19px; font-weight: 650; letter-spacing: -.3px; }
.ghw h4 { font-size: 14px; font-weight: 620; }
.ghw a { color: var(--ghw-accent); text-decoration: none; }
.ghw :where(button, input, select, textarea) { font: inherit; margin: 0; }
.ghw button { -webkit-appearance: none; appearance: none; cursor: pointer; }
.ghw button:disabled, .ghw input:disabled, .ghw select:disabled, .ghw textarea:disabled { opacity: .45; cursor: default; }
.ghw :is(button, input, select, textarea, summary, a):focus-visible { outline: 2px solid var(--ghw-accent); outline-offset: 3px; }
.ghw .ghw-muted { font-size: 12px; color: var(--ghw-muted); line-height: 1.7; }
.ghw-grow { flex: 1; }

/* Native popup/search appearances can ignore padding and height on WebKit. */
.ghw input:is([type=text], [type=search]), .ghw select, .ghw textarea {
  -webkit-appearance: none;
  appearance: none;
  display: block;
  width: 100%;
  min-width: 0;
  border: 1px solid var(--ghw-line);
  border-radius: var(--ghw-radius);
  background-color: transparent;
  color: inherit;
  padding: 9px 12px;
  font-size: 13px;
  line-height: 20px;
}
.ghw input:is([type=text], [type=search]), .ghw select { height: var(--ghw-control-height); min-height: var(--ghw-control-height); }
.ghw select {
  padding-inline-end: 36px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' fill='none' stroke='%23858b95' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-size: 16px 16px;
  background-position: right 12px center;
  text-overflow: ellipsis;
}
.ghw select option, .ghw select optgroup { color: CanvasText; background: Canvas; }
.ghw input::placeholder, .ghw textarea::placeholder { color: var(--ghw-muted); opacity: 1; }
.ghw input[type=search]::-webkit-search-decoration { -webkit-appearance: none; }
.ghw textarea { min-height: 96px; resize: vertical; }
.ghw-field { min-width: 0; }
.ghw-field label, .ghw-policy label, .ghw-diff > label {
  display: flex; align-items: center; gap: 8px;
  min-height: 18px; margin-bottom: 8px;
  color: var(--ghw-muted); font-size: 12px; line-height: 18px; font-weight: 550;
}

.ghw-button {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  min-height: var(--ghw-control-height); padding: 9px 12px;
  border: 1px solid var(--ghw-line); border-radius: var(--ghw-radius);
  background: var(--ghw-surface); color: inherit;
  font-size: 13px; font-weight: 550; line-height: 20px;
  white-space: nowrap; text-decoration: none;
  transition: background .15s, border-color .15s;
}
.ghw-button svg { flex: none; width: 18px; height: 18px; }
.ghw-button:hover:not(:disabled) { background: color-mix(in srgb, currentColor 7%, transparent); border-color: color-mix(in srgb, currentColor 25%, transparent); }
.ghw-button.is-primary { color: white; background: var(--ghw-accent); border-color: var(--ghw-accent); }
.ghw-button.is-primary:hover:not(:disabled) { background: #3c64d4; }
.ghw-button.is-quiet { min-height: 32px; padding: 5px 8px; border-color: transparent; background: transparent; color: var(--ghw-muted); font-size: 12px; }
.ghw .ghw-link { padding: 0; border: 0; background: transparent; color: var(--ghw-accent); font-size: 12px; }

.ghw-header, .ghw-heading, .ghw-account, .ghw-actions, .ghw-card-title, .ghw-task, .ghw-recent, .ghw-project-header { display: flex; align-items: center; }
.ghw-header { justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 24px; }
.ghw-heading { min-width: 0; gap: 12px; }
.ghw-heading p { margin-top: 6px; color: var(--ghw-muted); font-size: 12px; }
.ghw-brand { display: grid; place-items: center; flex: none; width: 40px; height: 40px; border-radius: 12px; color: var(--ghw-accent); background: color-mix(in srgb, var(--ghw-accent) 9%, transparent); }
.ghw-brand svg { width: 24px; height: 24px; }
.ghw-account { flex-wrap: wrap; gap: 8px; font-size: 12px; }
.ghw-account > span:not(.ghw-dot) { overflow-wrap: anywhere; }
.ghw-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: #aaa; }
.ghw-dot.is-connected { background: #40a878; }

.ghw-picker {
  display: grid; align-items: end;
  grid-template-columns: minmax(140px, 1fr) minmax(200px, 1.5fr) minmax(160px, 1fr) auto;
  gap: 16px; min-width: 0; padding: 20px 20px 14px;
  border: 1px solid var(--ghw-line); border-radius: 12px; background: var(--ghw-surface);
}
.ghw-open { align-self: end; }
.ghw-picker-footer { grid-column: 1 / -1; display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; min-height: 20px; color: var(--ghw-muted); font-size: 11px; }
.ghw-recent { flex-wrap: wrap; gap: 8px; margin: 16px 0 24px; }
.ghw-recent > span { margin-right: 4px; color: var(--ghw-muted); font-size: 12px; }
.ghw-chip { max-width: 230px; padding: 5px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--ghw-muted); font-size: 12px; }
.ghw-chip:hover { background: var(--ghw-surface); }
.ghw-chip.is-selected { color: var(--ghw-accent); background: color-mix(in srgb, var(--ghw-accent) 8%, transparent); border-color: color-mix(in srgb, var(--ghw-accent) 12%, transparent); }

.ghw-card { min-width: 0; padding: 20px; border: 1px solid var(--ghw-line); border-radius: 12px; }
.ghw-card-title { justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.ghw-encryption { margin: 16px 0; }
.ghw-encryption summary { list-style: none; cursor: pointer; }
.ghw-encryption summary::-webkit-details-marker { display: none; }
.ghw-encryption > summary { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; font-size: 14px; font-weight: 600; line-height: 24px; }
.ghw-encryption > summary > .ghw-muted { font-weight: 400; }
.ghw-disclosure-title { display: inline-flex; align-items: center; gap: 8px; }
.ghw-disclosure-title::before, .ghw-encryption-advanced > summary::before { content: ''; display: inline-block; flex: none; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); }
.ghw-encryption[open] > summary .ghw-disclosure-title::before, .ghw-encryption-advanced[open] > summary::before { transform: rotate(45deg); }
.ghw-encryption-advanced > summary::before { margin-right: 10px; vertical-align: 2px; }
.ghw-encryption form { display: grid; gap: 16px; margin-top: 20px; }
.ghw-encryption-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: end; gap: 16px; }
.ghw-encryption-fields > .ghw-field:only-child { grid-column: 1 / -1; }
.ghw-encryption form > button { justify-self: start; }
.ghw-encryption-advanced > summary { color: var(--ghw-muted); font-size: 12px; line-height: 20px; cursor: pointer; }
.ghw-encryption-advanced .ghw-field { max-width: 540px; margin-top: 16px; }

.ghw-banner { display: flex; align-items: center; gap: 12px; margin: 16px 0; padding: 12px 16px; border: 1px solid var(--ghw-line); border-radius: var(--ghw-radius); font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.ghw-banner.is-error { color: #d16b4e; background: #d16b4e09; border-color: #d16b4e33; }
.ghw-banner.is-success { color: #38916b; background: #38916b08; border-color: #38916b28; }
.ghw-dismiss { margin-left: auto; padding: 0 3px; border: 0; background: none; color: inherit; font-size: 19px; }
.ghw-login { flex-wrap: wrap; }
.ghw-login code { font-size: 18px; letter-spacing: 2px; }
.ghw-tasks { margin: 16px 0; }
.ghw-task { gap: 12px; margin: 8px 0; padding: 16px; border: 1px solid color-mix(in srgb, var(--ghw-accent) 24%, transparent); border-radius: 12px; background: color-mix(in srgb, var(--ghw-accent) 4%, transparent); }
.ghw-task-body { display: grid; gap: 4px; flex: 1; min-width: 0; }
.ghw-task-body strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.ghw-task-body > span { color: var(--ghw-muted); font-size: 12px; }
.ghw-task progress { width: 100%; max-width: 420px; height: 3px; margin-top: 4px; accent-color: var(--ghw-accent); }
.ghw-spinner { display: inline-block; flex: none; width: 13px; height: 13px; border: 1.5px solid var(--ghw-line); border-top-color: var(--ghw-accent); border-radius: 50%; animation: ghw-spin .8s linear infinite; }
@keyframes ghw-spin { to { transform: rotate(360deg); } }

.ghw-empty { padding: 48px 20px; text-align: center; color: var(--ghw-muted); }
.ghw-empty h3 { margin: 16px 0 8px; color: inherit; font-size: 16px; }
.ghw-empty p { max-width: 410px; margin: 0 auto; font-size: 12px; }
.ghw-empty code { display: inline-block; max-width: 100%; margin-top: 16px; padding: 5px 12px; border-radius: 6px; background: var(--ghw-surface); font-size: 12px; overflow-wrap: anywhere; }
.ghw-empty-icon { display: inline-grid; place-items: center; width: 56px; height: 56px; border: 1px solid var(--ghw-line); border-radius: 16px; background: var(--ghw-surface); }
.ghw-empty-icon svg { width: 26px; height: 26px; }
.ghw-project-header { justify-content: space-between; flex-wrap: wrap; gap: 16px; margin: 28px 0 16px; }
.ghw-project-header > div { min-width: 0; max-width: 100%; }
.ghw-project-header h3 { overflow-wrap: anywhere; }
.ghw-eyebrow { margin-bottom: 4px; color: var(--ghw-muted); font-size: 10px; letter-spacing: 1.1px; text-transform: uppercase; }
.ghw-project-path { display: block; max-width: 580px; margin-top: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ghw-muted); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; }
.ghw-tabs { display: flex; align-items: center; flex-wrap: wrap; gap: 0 20px; margin-bottom: 20px; border-bottom: 1px solid var(--ghw-line); }
.ghw-tabs button { min-height: 44px; padding: 10px 0; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--ghw-muted); font-size: 12px; }
.ghw-tabs button.is-selected { color: var(--ghw-accent); border-bottom-color: var(--ghw-accent); }
.ghw-tabs button span { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 4px; background: var(--ghw-surface); font-size: 11px; }
.ghw-tabs .ghw-refresh { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; margin-left: auto; padding: 10px 6px; }
.ghw-overview { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 20px; }
.ghw-status-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 16px 0; font-size: 12px; }
.ghw-status-pill { display: inline-block; padding: 3px 8px; border: 1px solid var(--ghw-line); border-radius: 6px; background: var(--ghw-surface); font-size: 11px; white-space: nowrap; }
.ghw-status-pill.is-auto { color: #38916b; border-color: #38916b30; background: #38916b0a; }
.ghw-status-pill.is-paused { color: #bd8a32; border-color: #bd8a3230; background: #bd8a320a; }
.ghw-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
.ghw-stats > div { display: grid; gap: 6px; }
.ghw-stats strong { font-size: 25px; line-height: 1.2; font-weight: 600; letter-spacing: -.5px; }
.ghw-stats span { color: var(--ghw-muted); font-size: 11px; }
.ghw-actions { flex-wrap: wrap; gap: 8px; margin-top: 20px; }
.ghw-policy { display: grid; grid-template-columns: 88px minmax(0, 1fr); align-items: center; gap: 12px; margin: 16px 0; }
.ghw-policy label { margin: 0; }
.ghw-policy-error { margin: 12px 0 !important; color: #d16b4e; font-size: 12px; overflow-wrap: anywhere; }
.ghw-card > .ghw-button { margin-top: 16px; }
.ghw-changes { display: grid; grid-template-columns: minmax(220px, .8fr) minmax(0, 1.4fr); gap: 20px; }
.ghw-file-list { max-height: 340px; margin: 0 -8px 16px; overflow: auto; }
.ghw-file { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 6px; font-size: 12px; cursor: pointer; }
.ghw-file:hover { background: var(--ghw-surface); }
.ghw-file input { flex: none; accent-color: var(--ghw-accent); }
.ghw-file code { min-width: 17px; color: var(--ghw-accent); font-size: 11px; }
.ghw-file > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ghw-file.is-blocked { opacity: .45; cursor: default; }
.ghw-diff pre { max-height: 400px; margin: 16px 0; padding: 16px; overflow: auto; overflow-wrap: anywhere; white-space: pre-wrap; border: 1px solid var(--ghw-line); border-radius: var(--ghw-radius); background: var(--ghw-surface); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; line-height: 1.7; }
.ghw-small-empty { padding: 40px 12px; text-align: center; color: var(--ghw-muted); }
.ghw-small-empty h4 { margin-bottom: 8px; color: inherit; }
.ghw-small-empty p { font-size: 12px; }

@container ghw (max-width: 880px) {
  .ghw-picker { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ghw-search { grid-column: 1; grid-row: 2; }
  .ghw-open { grid-column: 2; grid-row: 2; }
  .ghw-picker-footer { grid-row: 3; }
}
@container ghw (max-width: 760px) {
  .ghw-overview, .ghw-changes { grid-template-columns: 1fr; }
}
@container ghw (max-width: 520px) {
  .ghw-picker { grid-template-columns: 1fr; padding: 16px; }
  .ghw-search, .ghw-open, .ghw-picker-footer { grid-column: 1; grid-row: auto; }
  .ghw-encryption-fields { grid-template-columns: 1fr; }
  .ghw-card { padding: 16px; }
  .ghw-account { width: 100%; justify-content: flex-end; }
  .ghw-policy { grid-template-columns: 1fr; gap: 8px; }
  .ghw-tabs { column-gap: 12px; }
  .ghw-stats strong { font-size: 22px; }
}
@supports not (container-type: inline-size) {
  @media (max-width: 1100px) {
    .ghw-picker { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .ghw-search { grid-column: 1; grid-row: 2; }
    .ghw-open { grid-column: 2; grid-row: 2; }
    .ghw-picker-footer { grid-row: 3; }
    .ghw-overview, .ghw-changes { grid-template-columns: 1fr; }
  }
  @media (max-width: 620px) {
    .ghw-picker { grid-template-columns: 1fr; padding: 16px; }
    .ghw-search, .ghw-open, .ghw-picker-footer { grid-column: 1; grid-row: auto; }
    .ghw-encryption-fields { grid-template-columns: 1fr; }
    .ghw-card { padding: 16px; }
    .ghw-account { width: 100%; justify-content: flex-end; }
    .ghw-policy { grid-template-columns: 1fr; gap: 8px; }
  }
}
@media (prefers-reduced-motion: reduce) { .ghw-spinner { animation: none; } .ghw-button { transition: none; } }
@media (forced-colors: active) { .ghw select { appearance: auto; background-image: none; } }
`
