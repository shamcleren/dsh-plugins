export const importedStyles = new Set<string>()
export function registerImportedStyle(css: string): void { importedStyles.add(css) }
export const styles = `
.saas-workspace{padding:18px;color:inherit;font:inherit;height:100%;overflow:auto;box-sizing:border-box}
.saas-workspace *{box-sizing:border-box}.saas-workspace h2{font-size:18px;margin:0 0 6px}.saas-workspace p{line-height:1.6}
.saas-workspace button{font:inherit;border:1px solid #8894a44d;border-radius:8px;padding:7px 12px;background:transparent;color:inherit;cursor:pointer}
.saas-workspace button:disabled{opacity:.5;cursor:default}.saas-workspace button[aria-selected=true]{background:#3575ed18;border-color:#3575ed;color:#3575ed}
.saas-actions,.saas-tabs{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.saas-note{font-size:12px;opacity:.75;overflow-wrap:anywhere}
.saas-status{border-left:3px solid #3575ed;padding:10px 12px;background:#3575ed0a}.saas-error{color:#bc4529}.saas-result{min-height:100px;margin-top:14px}
.saas-screenshot{max-width:100%;border:1px solid #8894a44d;border-radius:8px;display:block}.saas-source-button{padding:0!important;display:block;width:100%}
.saas-modal{position:fixed;inset:5%;z-index:1000;background:Canvas;color:CanvasText;box-shadow:0 0 0 100vmax #0009;padding:18px;overflow:auto;border-radius:12px}
.saas-modal>button{position:sticky;top:0;float:right;background:Canvas}.saas-tool-card{padding:10px 0}.saas-tool-card button{padding:7px 12px;border:1px solid #8894a44d;border-radius:8px;background:transparent;color:inherit;cursor:pointer}
.saas-login-dialog{pointer-events:auto;width:min(520px,calc(100vw - 40px));max-height:calc(100vh - 60px);overflow:auto;padding:28px;border:1px solid #8894a44d;border-radius:16px;background:Canvas;color:CanvasText;font:15px/1.7 system-ui;box-shadow:0 20px 70px #0004}
.saas-login-dialog::backdrop{background:#09152788;backdrop-filter:blur(3px)}.saas-login-dialog h2{font-size:24px;line-height:1.3;margin:14px 0 16px}.saas-login-badge{font-size:12px;letter-spacing:.04em;color:#3575ed}
.saas-login-dialog button{font:inherit;font-size:14px;padding:9px 13px;border:1px solid #8894a44d;border-radius:8px;background:transparent;color:inherit;cursor:pointer}.saas-login-dialog button:disabled{opacity:.55;cursor:default}
.saas-login-dialog .saas-login-primary{background:#2867dc;color:white;border-color:#2867dc}.saas-login-dialog .saas-actions{margin-top:24px}.saas-login-query{padding:10px 12px;background:#3575ed0d;border-radius:8px;overflow-wrap:anywhere}
`
