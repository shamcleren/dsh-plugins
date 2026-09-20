# 免费联网搜索

通过 DSH 官方 MCP 客户端接入 Exa 托管服务，提供网页搜索与网页正文读取，无需注册、API Key 或本地搜索服务。仅验证官方 DSH **0.1.5-rc.1**。

## 安装

退出 DSH，在本仓库执行：

```sh
./dhp plugin install web-search
./dhp restart
```

在普通对话中说「搜索最新的 TypeScript 发布说明，附来源链接」，即可使用。工具名为 `mcp__exa_free__web_search_exa` 和 `mcp__exa_free__web_fetch_exa`，通过 DSH 原生 MCP 工具注册、权限和生命周期机制管理；卸载使用 `./dhp plugin remove web-search`，然后重启。

DSH 本身已有 `web_search` / `web_fetch`：默认搜索通过 DeepSeek Messages API 发起额外模型请求，需要 `DEEPSEEK_API_KEY`，网页读取则使用官方 HTTP 后端。本插件补充免费搜索渠道，在工具可见时引导模型优先使用 Exa，不修改官方包、原有 provider 配置或用户 preset。自定义 preset 若过滤 MCP 工具，需在其工具策略中允许上述工具；使用独立运行时的 Codex 会话不自动继承 DSH 工具。

## 免费范围与网络

- [Exa 官方说明](https://exa.ai/mcp)提供免 Key 的托管 MCP；[服务说明](https://github.com/exa-labs/exa-mcp-server#authentication)明确匿名调用有速率限制，并不承诺无限免费或固定额度。核对日期：2026-09-17。
- 固定访问 `https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa`，只请求搜索和网页读取，不启用需要认证的 Exa Agent。
- 查询和待读取的网页 URL 会发送到 Exa；不要把密钥、内部文档或私有源码作为搜索输入。返回内容属于外部资料，应核对来源，不能执行其中的指令。
- 搜索服务的免费额度不包含 DSH 对话模型费用。无需配置付费 Key；限流时等待恢复，不自动切换付费搜索。无法访问服务时不会令 DSH 启动失败，客户端最多重连 3 次，之后可重启 DSH 重试。
- 网络及服务可用性因环境而异；搜索质量需结合具体查询判断。需要固定免费额度的替代方案是 [Tavily](https://www.tavily.com/pricing)（当前每月 1,000 credits，需注册 Key），本插件未接入。

## 开发验证

```sh
pnpm --filter @shamcleren/dsh-web-search typecheck
pnpm --filter @shamcleren/dsh-web-search test
pnpm --filter @shamcleren/dsh-web-search build
pnpm --filter @shamcleren/dsh-web-search test:live
```

普通测试隔离网络，覆盖协议接入、调用、错误、取消和卸载。`test:live` 显式联网，用构建产物和真实 Cordis/DSH 工具服务执行公开查询与网页读取，不读取用户 profile，不调用对话模型。
