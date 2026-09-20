import type { Report } from './report.js'
export function codeViewer(report: Report): string {
  const encoded = JSON.stringify(report.evidenceArchive?.snippets ?? []).replace(/</gu, '\\u003c').replace(/>/gu, '\\u003e').replace(/&/gu, '\\u0026').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029')
  return '<dialog id="code-view"><div class="code-toolbar"><h2 id="code-title">扫描代码依据</h2><button id="close-code">关闭</button></div><p id="code-proof"></p><pre id="code-lines"></pre><p id="code-note"></p></dialog><script type="application/json" id="code-data">' + encoded + '</script>'
}
export const codeViewerScript = `
const excerpts=JSON.parse($('code-data').textContent);let sourceTrigger;
for(const link of document.querySelectorAll('.source-link'))link.addEventListener('click',event=>{
 event.preventDefault();const file=link.dataset.file,line=Number(link.dataset.line);sourceTrigger=link;
 const snippet=excerpts.filter(s=>s.file===file&&s.start<=line&&s.start+s.lines.length>line).sort((a,b)=>b.lines.length-a.lines.length)[0];
 $('code-title').textContent=file+':'+line;$('code-lines').replaceChildren();
 $('code-proof').textContent=snippet?'来源：扫描时留存的代码片段 · 原文件 SHA-256：'+snippet.sourceHash:'此位置没有留存代码片段。';
 if(snippet)for(const [i,text] of snippet.lines.entries()){const row=document.createElement('span');row.textContent=String(snippet.start+i).padStart(5,' ')+'  '+text+'\\n';if(snippet.start+i===line){row.className='code-current';row.setAttribute('aria-label','当前定位行 '+line)}$('code-lines').append(row)}
 $('code-note').textContent=snippet?(snippet.redacted?'敏感内容已隐藏；占位符不能证明原始内容无风险。':'此处为留档片段，不读取当前工作区，也不执行代码。'):'旧报告未留存、记录超限或位置不在留档范围内。请重新扫描生成带离线代码依据的报告；不会用当前文件替代历史证据。';
 $('code-view').showModal();$('code-lines').querySelector('.code-current')?.scrollIntoView({block:'center'});
});
$('close-code').onclick=()=>$('code-view').close();$('code-view').addEventListener('close',()=>sourceTrigger?.focus());
`
