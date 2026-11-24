import { createServer } from 'node:http'

/** Local synthetic service market; never uses an account or contacts another origin. */
export async function startFixture({ requireLogin = false, indirectConfig = false, execution = false, approvals = false } = {}) {
  let origin
  const disclosure = `<button type="button" style="position:fixed;top:400px;left:100px;width:180px;height:44px"
    aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('fixture-resource').hidden=false">知识库（1）</button>
    <section hidden id="fixture-resource"><p>Fixture retrieval handbook</p><label>检索数量<input type="number" value="5"></label></section>`
  const stats = { messages: [], saves: 0 }
  const rows = [
    ['初始化助手', '单智能体', 'v1.2', '运维', '帮助团队完成项目初始化和环境检查。'],
    ['初始化流程', '工作流', 'v2.0', '流程', '逐项检查初始化参数并给出建议。'],
    ['发布检查助手', '单智能体', 'v1.0', '研发', '核对初始化配置和发布检查清单。'],
    ['知识检索助手', '单智能体', 'v3.1', '知识', '检索知识库并展示引用依据。'],
    ['工单协作', '多智能体', 'v1.5', '服务', '汇总工单进展。'],
  ].map(([name, type, version, tag, description], index) => ({ name, type, version, tag, description, id: index }))
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>服务市场 · 演示数据</title>
  <style>body{margin:0;font:15px system-ui;background:#f4f6fa;color:#22314b}header{background:#fff;padding:22px 32px;border-bottom:1px solid #dde4ef}aside{position:absolute;top:85px;width:170px;padding:30px}main{margin-left:210px;padding:28px}h1{font-size:24px}small{color:#728098}.div-input{padding:12px;background:#fff;border:1px solid #ced8e9;border-radius:8px;min-height:20px;width:520px}.g-resource-list{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:24px}.resource-card-home{background:white;border:1px solid #e0e6ef;border-radius:12px;padding:20px;min-height:205px}.resource-card-name{font-size:18px;font-weight:650;margin-bottom:14px}.agent-type,.resource-version{font-size:12px;color:#5d6980;margin-right:12px}.resource-card-description{line-height:1.8;color:#58677f;min-height:70px}.tag-home{font-size:12px;background:#edf3ff;color:#527bd1;padding:3px 6px}.buttons{margin-top:18px;display:flex;gap:10px}button{border:0;border-radius:5px;padding:7px;background:#edf3ff;color:#3d6ad1}</style>
  <header>◈ SaaS Workspace <a href="/development">智能体开发</a> <small>本地演示 · 无真实账号</small></header><aside>服务市场<br><br><b>智能体</b><br><br>知识库</aside><main><h1>智能体</h1><p>全部 <b>52</b> <small>（站点全局总数，搜索后保持不变）</small></p><div class="div-input input-before" contenteditable="true" role="textbox" aria-label="搜索智能体"></div><div class="g-resource-list" aria-live="polite"></div></main>
  <script>
  const input=document.querySelector('.div-input'), root=document.querySelector('.g-resource-list');
  function render(rows){root.replaceChildren();if(!rows.length){root.textContent='暂无智能体';return}for(const row of rows){const card=document.createElement('article');card.className='resource-card-home';for(const [cls,value] of [['resource-card-name',row.name],['agent-type',row.type],['resource-version',row.version],['resource-card-description',row.description],['tag-home',row.tag]]){const el=document.createElement('div');el.className=cls;el.textContent=value;card.append(el)}const buttons=document.createElement('div');buttons.className='buttons';for(const label of (location.pathname==='/development'||!${indirectConfig}?['去配置调试','去使用']:['去使用'])){const b=document.createElement('button');b.textContent=label;b.disabled=label==='去使用';if(!b.disabled)b.onclick=()=>location.assign('/agents/config?id='+row.id);buttons.append(b)}card.append(buttons);root.append(card)}}
  async function load(keyword=''){const response=await fetch('/cards?keyword='+encodeURIComponent(keyword));render(await response.json())}
  input.addEventListener('input',()=>input.classList.remove('input-before'));
  input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();load(input.textContent.trim())}});load();
  </script></html>`
  const chat = mode => `<section class="${mode}-chat"><h2>${mode === 'debug' ? '预览调试' : '应用对话'}</h2><textarea class="message" aria-label="消息"></textarea><button class="send" onclick="sendMessage()">发送</button><div class="answers"></div></section><script>async function sendMessage(){const send=document.querySelector('.send');send.classList.add('busy');try{const r=await fetch('/reply?mode=${mode}',{method:'POST',body:document.querySelector('.message').value});const result=await r.json();const answer=document.createElement('div');answer.className=result.error?'error':'reply';answer.textContent=result.error||result.text;document.querySelector('.answers').append(answer)}finally{send.classList.remove('busy')}}</script>`
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    if (url.pathname === '/login') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>模拟企业登录</title><main><h1>模拟企业登录</h1><p>本地测试，无真实账号。登录后将保留本任务浏览器的会话。</p><form action="/login/complete" method="post"><button>完成模拟登录</button></form></main></html>'); return
    }
    if (url.pathname === '/login/complete' && request.method === 'POST') { response.writeHead(303, { location: origin + '/session-established' }); response.end(); return }
    if (url.pathname === '/session-established') { response.writeHead(303, { location: '/agents', 'set-cookie': 'fixture-session=active; HttpOnly; SameSite=Lax; Path=/' }); response.end(); return }
    if (requireLogin && !request.headers.cookie?.split(';').some(value => value.trim() === 'fixture-session=active')) {
      response.writeHead(302, { location: origin.replace('127.0.0.1', 'localhost') + '/login' }); response.end(); return
    }
    if (execution && url.pathname === '/reply' && request.method === 'POST') {
      const chunks = []; request.on('data', bytes => chunks.push(bytes)); request.on('end', () => {
        const message = Buffer.concat(chunks).toString('utf8'), mode = url.searchParams.get('mode')
        stats.messages.push({ mode, message })
        const numbers = message.match(/(-?\d+)\s*\+\s*(-?\d+)/)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(numbers ? { text: String(Number(numbers[1]) + Number(numbers[2])) } : { error: '请提供加法表达式' }))
      }); return
    }
    if (execution && url.pathname === '/save') { stats.saves++; response.end(); return }
    if (execution && url.pathname === '/use') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><meta charset="utf-8"><title>应用使用 · 本地测试</title>' + chat('use')); return
    }
    if (url.pathname === '/cards') {
      const keyword = url.searchParams.get('keyword') ?? ''
      const found = keyword === 'bulk' ? Array.from({ length: 60 }, (_, i) => ({ ...rows[0], name: `批量助手 ${i + 1}` })) : rows.filter(row => (row.name + row.description).includes(keyword))
      // Async response leaves old cards visible until the query has completed.
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      setImmediate(() => response.end(JSON.stringify(found))); return
    }
    if (url.pathname === '/agents/config') {
      const row = rows.find(row => String(row.id) === url.searchParams.get('id'))
      if (!row) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>智能体配置 · 测试数据</title><main><h1>${row.name} · 配置</h1><label>名称<input value="${row.name}" readonly></label><label>模型<input value="fixture-model" readonly></label><label><input type="radio" name="mode" value="user_define" checked>自定义 Prompt</label><label><input type="radio" name="mode" value="collection">引用角色</label><label>系统提示词<textarea readonly>帮助团队完成初始化检查。</textarea></label><label>API Key<input type="password" value="fixture-secret" readonly></label><button onclick="fetch('/save',{method:'POST'})">保存</button>${execution ? '<button onclick="window.open(\'/use\')">去使用</button>' + chat('debug') : '<button>运行调试</button>'}<a href="/agents">返回</a>${approvals ? disclosure : ""}</main></html>`); return
    }
    if (url.pathname === '/agents' || url.pathname === '/development' || url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return }
    response.writeHead(404); response.end()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${server.address().port}`
  return { server, origin, stats, site: { name: '智能体服务市场 · 本地演示', url: origin + '/agents', allowedOrigins: [origin, ...(requireLogin ? [origin.replace('127.0.0.1', 'localhost')] : [])], blockedHosts: [], ...(approvals ? { approvalPaths: ['/agents/config'] } : {}),
    ...(execution ? { execution: ['debug', 'use'].map(mode => ({ mode, origin, paths: [mode === 'debug' ? '/agents/config' : '/use'], scope: '.' + mode + '-chat', input: '.message', submit: '.send', output: '.reply', busy: '.send.busy', error: '.error' })) } : {}),
    selectors: { search: '.div-input[contenteditable="true"]', results: '.g-resource-list', card: '.resource-card-home', name: '.resource-card-name', type: '.agent-type', version: '.resource-version', tags: '.tag-home', description: '.resource-card-description' }, emptyText: '暂无智能体', screenshotMasks: [] },
    close: () => new Promise(resolve => server.close(resolve)) }
}
