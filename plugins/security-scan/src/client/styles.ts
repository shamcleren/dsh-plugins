export const css = `
.security-nav-host{width:100%;min-width:0}
.security-nav-trigger{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:calc(100% + 4px);height:42px;flex:none;margin:4px -2px;padding:0 10px 0 8px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;text-align:left;overflow:hidden;white-space:nowrap}
.security-nav-trigger svg{flex:none}.security-nav-host.rail{width:auto}.security-nav-host.rail .security-nav-trigger{width:36px;height:36px;margin:8px 0 10px;padding:0;justify-content:center;gap:0;border-radius:50%}
.security-nav-trigger:hover{background:var(--dsw-alias-interactive-bg-hover,#edf2fb)}.security-nav-trigger:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#477dea);outline-offset:2px}

.security-workbench{
  --scan-bg:var(--dsw-alias-bg-layer-1,#f5f7fb);
  --scan-surface:var(--dsw-alias-bg-layer-2,#fff);
  --scan-subtle:var(--dsw-alias-bg-layer-3,#edf1f8);
  --scan-border:var(--dsw-alias-border-l2,#dce3ef);
  --scan-text:var(--dsw-alias-label-primary,#19263b);
  --scan-muted:var(--dsw-alias-label-tertiary,#697c96);
  --scan-accent:var(--dsw-alias-brand-primary,#416bd9);
  --scan-on-accent:var(--dsw-alias-label-primary-foreground,#fff);
  position:absolute;inset:0;pointer-events:auto;z-index:50;background:var(--scan-bg);color:var(--scan-text);display:flex;flex-direction:column;font:14px/1.55 system-ui,-apple-system,sans-serif;text-align:left;
}
.security-workbench *{box-sizing:border-box}
.security-workbench h1{font-size:22px;font-weight:650;letter-spacing:-.4px;margin:0}
.security-workbench h2{font-size:18px;margin:0 0 18px}.security-workbench h3{font-size:15px;margin:0}
.security-workbench p{margin:6px 0;overflow-wrap:anywhere}.security-workbench .muted{color:var(--scan-muted);font-size:12px;line-height:1.6}
.security-workbench .grow{flex:1;min-width:0}.security-workbench .error,.security-workbench .danger{color:#d14f59}.security-workbench .notice{color:#228467}

/* Native selects otherwise retain a shorter platform control despite input padding. */
.security-workbench input:not([type=checkbox]),.security-workbench select,.security-workbench textarea{
  appearance:none;-webkit-appearance:none;display:block;width:100%;min-width:0;border:1px solid var(--scan-border);border-radius:8px;background:var(--scan-surface);color:var(--scan-text);font:inherit;font-size:14px;line-height:20px;padding:9px 12px;box-shadow:none;
}
.security-workbench input:not([type=checkbox]),.security-workbench select{height:40px}
.security-workbench select{padding-right:36px;text-overflow:ellipsis;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Cpath d='m4 6 4 4 4-4' fill='none' stroke='%237b8797' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 12px center;background-size:16px;background-repeat:no-repeat}
.security-workbench option{background:var(--scan-surface);color:var(--scan-text)}
.security-workbench textarea{min-height:120px;resize:vertical}
.security-workbench input::placeholder,.security-workbench textarea::placeholder{color:var(--scan-muted);opacity:.8}
.security-workbench input:not([type=checkbox]):hover:not(:disabled),.security-workbench select:hover:not(:disabled),.security-workbench textarea:hover:not(:disabled){border-color:var(--scan-muted)}
.security-workbench input:focus-visible,.security-workbench select:focus-visible,.security-workbench textarea:focus-visible,.security-workbench button:focus-visible,.security-workbench summary:focus-visible{outline:2px solid var(--scan-accent);outline-offset:2px}
.security-workbench input:disabled,.security-workbench select:disabled,.security-workbench textarea:disabled{background-color:var(--scan-subtle);opacity:.6;cursor:not-allowed}
.security-workbench button{appearance:none;-webkit-appearance:none;cursor:pointer;min-height:40px;flex-shrink:0;border:1px solid var(--scan-border);border-radius:8px;padding:9px 14px;background:var(--scan-surface);color:var(--scan-text);font:inherit;font-size:14px;line-height:20px;transition:background .15s,border-color .15s}
.security-workbench button:hover:not(:disabled){background:var(--scan-subtle);border-color:var(--scan-muted)}
.security-workbench button:disabled{cursor:not-allowed;opacity:.5}
.security-workbench button.danger{color:#d14f59}.security-workbench button.danger:hover:not(:disabled){border-color:currentColor}
/* Brand backgrounds invert in dark mode; their foreground must invert as well. */
.security-workbench button.primary{background:var(--scan-accent);border-color:var(--scan-accent);color:var(--scan-on-accent)}
.security-workbench button.primary:hover:not(:disabled){background:color-mix(in srgb,var(--scan-accent) 90%,var(--scan-on-accent));border-color:var(--scan-accent)}
.security-workbench button.primary:active:not(:disabled){background:color-mix(in srgb,var(--scan-accent) 80%,var(--scan-on-accent))}

.security-workbench header{display:flex;gap:18px;align-items:center;flex-shrink:0;border-bottom:1px solid var(--scan-border);padding:20px 28px;background:var(--scan-surface)}
.security-workbench header>button:first-child{border-color:transparent;background:transparent}
.security-workbench .body{display:flex;flex-direction:column;flex:1;min-height:0}
.security-workbench nav{display:flex;flex-shrink:0;gap:24px;padding:0 28px;overflow-x:auto;border-bottom:1px solid var(--scan-border);background:var(--scan-surface)}
.security-workbench nav button{display:flex;align-items:center;gap:8px;min-height:52px;padding:14px 2px;border:0;border-bottom:2px solid transparent;border-radius:0;white-space:nowrap;color:var(--scan-muted);background:transparent}
.security-workbench nav button:hover:not(:disabled){background:transparent;border-bottom-color:var(--scan-border);color:var(--scan-text)}
.security-workbench nav button.selected{border-bottom-color:var(--scan-accent);color:var(--scan-accent);font-weight:650}
.security-workbench .nav-count{font-size:11px;line-height:18px;min-width:20px;padding:0 5px;border-radius:5px;background:var(--scan-subtle);text-align:center}
.security-workbench main{flex:1;min-width:0;overflow:auto;padding:28px 32px;scrollbar-gutter:stable}
.security-workbench .content{max-width:1120px;margin:0 auto}.security-workbench .report-content{max-width:none}
.security-workbench .toolbar{display:flex;flex-wrap:wrap;gap:12px;justify-content:space-between;align-items:center;margin-bottom:20px}.security-workbench .toolbar h2{margin:0}
.security-workbench .search{max-width:280px}.security-workbench .toolbar .search{flex:1 1 200px}
.security-workbench .cards{display:grid;gap:16px}
.security-workbench .card{border:1px solid var(--scan-border);border-radius:14px;padding:24px;background:var(--scan-surface);box-shadow:0 2px 8px #172b4d03;min-width:0}
.security-workbench .card-head{display:flex;gap:12px;align-items:flex-start}.security-workbench .card-head h3{font-size:16px}
.security-workbench .actions,.security-workbench .row-actions,.security-workbench .form-footer{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.security-workbench .actions{margin-top:16px;padding-top:16px;border-top:1px solid var(--scan-border)}.security-workbench .actions .danger{margin-left:auto}
.security-workbench .tags{display:flex;gap:7px;flex-wrap:wrap;margin:12px 0}
.security-workbench .tag{padding:2px 8px;border-radius:6px;background:var(--scan-subtle);font-size:12px;white-space:nowrap}
.security-workbench .tag.running,.security-workbench .tag.queued{color:#4c8df2}.security-workbench .tag.partial,.security-workbench .tag.failed,.security-workbench .tag.interrupted{color:#b97a26}.security-workbench .tag.succeeded{color:#26946a}
.security-workbench .empty{border:1px dashed var(--scan-border);border-radius:12px;padding:48px 24px;text-align:center}
.security-workbench .alert{padding:12px 16px;border-radius:8px;background:var(--scan-subtle);margin-bottom:16px}

.security-workbench .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 24px}
.security-workbench label.field{display:flex;flex-direction:column;gap:8px;min-width:0}.security-workbench label.field>span:first-child{font-weight:550}
.security-workbench .span{grid-column:1/-1}
.security-workbench fieldset{border:0;padding:0;margin:0;min-width:0}
.security-workbench .section-title{font-size:12px;color:var(--scan-muted);letter-spacing:.04em;padding:20px 0 0;border-top:1px solid var(--scan-border)}
.security-workbench .section-title:first-child{border-top:0;padding-top:0}
.security-workbench .check{display:flex;gap:12px;align-items:flex-start;padding:14px 0;cursor:pointer}
.security-workbench .check input{flex:none;width:16px;height:16px;margin:3px 0 0;accent-color:#2563eb}
.security-workbench .check p{margin:4px 0 0}
.security-workbench .form-footer{margin-top:24px;padding-top:20px;border-top:1px solid var(--scan-border)}
.security-workbench .agent-policy{margin:24px 0 10px;padding:4px 20px 20px;border:1px solid var(--scan-border);border-radius:12px;background:var(--scan-bg)}
.security-workbench .agent-policy .check{padding-bottom:12px}.security-workbench .agent-policy>p{margin:8px 0}
.security-workbench .flow{color:#697fd2;font-size:13px}.security-workbench .ai{background:var(--scan-subtle);color:#697fd2}
.security-workbench .model-picker{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px 12px;align-items:end;margin:18px 0 12px}
.security-workbench .model-picker p{grid-column:1/-1;margin:0}
.security-workbench .advanced{margin-top:24px;padding-top:18px;border-top:1px solid var(--scan-border)}
.security-workbench summary{cursor:pointer}.security-workbench .advanced summary{font-weight:550}.security-workbench .advanced[open]>p{margin:12px 0 18px}
.security-workbench .agent-trace{max-width:420px;font-size:12px}.security-workbench .agent-trace ol{max-height:180px;overflow:auto;padding-left:0;list-style:none;overflow-wrap:anywhere}
.security-workbench .agent-trace li{margin:6px 0}.security-workbench .agent-trace li b{display:inline-block;min-width:18px;color:#697caf}

.security-workbench table{width:100%;border-collapse:collapse;font-size:13px}
.security-workbench th{text-align:left;color:var(--scan-muted);font-size:12px;font-weight:550;padding:12px;white-space:nowrap}
.security-workbench td{padding:16px 12px;border-top:1px solid var(--scan-border);vertical-align:top;overflow-wrap:anywhere}
.security-workbench .table-wrap{overflow:auto}.security-workbench .table-wrap table{min-width:650px}
.security-workbench .row-actions{min-width:180px}.security-workbench .row-actions button{white-space:nowrap}
.security-workbench code{font-size:12px;overflow-wrap:anywhere}
.security-workbench iframe{display:block;width:100%;height:calc(100vh - 210px);border:1px solid var(--scan-border);border-radius:10px;background:white}
.security-workbench .confirm-box{max-width:680px;margin:20px auto;border:1px solid var(--scan-border);box-shadow:0 8px 32px #172b4d0a}
.security-workbench .source-preview{position:sticky;top:0;z-index:2;background:var(--scan-surface);border:1px solid var(--scan-border);padding:16px;border-radius:10px}
.security-workbench .source-preview pre{max-height:380px;overflow:auto;white-space:pre;background:var(--scan-bg)}.security-workbench .source-preview pre span{display:block}.security-workbench .source-highlight{background:#fff0b5;color:#172238}

.security-workbench .engine-panel{margin-bottom:24px}.security-workbench .engine-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:20px 0 4px}
.security-workbench .engine-item{display:flex;align-items:center;gap:12px;padding:16px;background:var(--scan-bg);border-radius:10px;min-width:0}
.security-workbench .engine-symbol{display:grid;place-items:center;flex:none;width:34px;height:34px;border-radius:9px;background:var(--scan-surface);font-size:23px;color:var(--scan-accent)}
.security-workbench .engine-progress{display:flex;align-items:center;gap:9px;margin-top:16px;color:var(--scan-accent)}
.security-workbench .environment-banner{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;margin-bottom:20px;border:1px solid var(--scan-border);border-radius:10px;background:var(--scan-surface);font-size:13px}
.security-workbench .spinner{width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:security-spin 1s linear infinite}
@keyframes security-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.security-workbench .spinner{animation:none}.security-workbench button{transition:none}}
@media(max-width:760px){
  .security-workbench header{padding:14px;gap:10px;flex-wrap:wrap}.security-workbench header .grow{flex-basis:calc(100% - 130px)}.security-workbench header>button:last-child{margin-left:auto}
  .security-workbench h1{font-size:19px}.security-workbench nav{gap:20px;padding:0 16px}.security-workbench main{padding:16px}
  .security-workbench .grid,.security-workbench .engine-grid{grid-template-columns:minmax(0,1fr)}.security-workbench .span{grid-column:auto}
  .security-workbench .card{padding:18px}.security-workbench .toolbar .search{max-width:none;order:3;flex-basis:100%}
  .security-workbench .environment-banner{align-items:flex-start;flex-direction:column}.security-workbench iframe{height:65vh}
}
@media(max-width:480px){
  .security-workbench .model-picker{grid-template-columns:minmax(0,1fr)}.security-workbench .model-picker button{justify-self:start}
  .security-workbench .agent-policy{padding:4px 14px 16px}.security-workbench .card-head{flex-wrap:wrap}.security-workbench .card-head .grow{flex-basis:100%}
  .security-workbench .form-footer button{flex:1 1 auto}.security-workbench .actions .danger{margin-left:0}
}
`
