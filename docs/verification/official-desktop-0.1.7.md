# 官方 Desktop 0.1.7-rc.2 替换评估

2026-09-28，macOS arm64。结论：**暂不替换现有应用壳**。官方 Host 能加载当前发布插件，但插件市场和系统文件分享尚不满足替换条件。

后续 Marketplace `0.4.7` 已修复当前 profile 识别并改用官方管理器；最新验证结果见[宿主适配记录](marketplace-host-profile.md)。下面保留 `0.4.6` 初次评估的证据，不代表新版本仍固定读取 Web。

## 官方包核验

- 来源：[官方 mac-arm64 更新源](https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml)，版本 `0.1.7-rc.2`，发布日期 `2026-09-24T14:10:00.562Z`。
- ZIP 大小 `372794444` 字节，SHA-512 与更新源一致。
- `codesign --verify --deep --strict` 通过，签名为 Hangzhou DeepSeek Artificial Intelligence Co., Ltd，Team ID `NAN929V4UM`，存在 stapled notarization ticket。
- `spctl --assess --type execute` 返回 accepted / Notarized Developer ID。
- 发布包描述符报告 Electron Node `24.18.1`，pnpm `11.7.0`。没有修改官方 App、ASAR 或内置依赖。

## 实测范围

使用独立 HOME / DSH_HOME，通过官方 CLI 在临时 Web profile 安装本仓库全部 10 个发布 tarball，将该测试 profile 移至独立 desktop 目录，然后以发布包内的 Electron Node 模式运行未修改的 `dsh-desktop-host`，传入官方内置运行时和包管理器。这验证实际发布包 Host 的加载和接口行为；不等同于官方 GUI 插件安装流程验收。

复现命令（App 路径指向已校验、解压的官方包）：

```sh
node scripts/smoke-runtime.mjs --desktop-app='/path/to/DeepSeek Harness.app'
```

通过项：

- 全部 10 个 catalog 包身份与 peer 检查，Host 无插件 activation failure。
- 19 个工具、2 个 Skill、Codex provider 注册。
- 旧设置导入，6 个实时配置表单读写、revision 冲突与静态字段保护。
- AIDEV 和安全审计预设解析。
- Security Scan / Marketplace / AIDEV / Codex 四条真实 Cookie / Origin 鉴权 RPC。
- 安全扫描创建原生观察会话、报告操作、按原配置复扫。
- 缺少凭据的 MCP 被禁用，离线 MCP 不阻塞已鉴权页面 HTTP 200。

## 阻塞项

### 插件市场操作了错误的 profile

实际 desktop profile 已安装 10 个 catalog 插件，但 Marketplace 的 `state().installed` 返回其中 **0 个**。新增验收断言据此失败，不能把 RPC HTTP 200 视为市场功能通过。

`plugins/marketplace/src/service.ts` 默认 `profile: web`，并通过 `process.execPath` / `process.argv[1]` 重启 CLI 执行包操作。官方 Desktop 的入口是独立 Host，profile 由 Desktop 管理；只把配置改为 desktop 不能证明安装操作兼容。市场的原生重启按钮还依赖自建 WebKit `dshNative` 桥接。

需要通过官方公开的插件管理能力适配当前 profile、安装/卸载和重启，再验证真实包操作。未对用户 desktop 或 web profile 执行市场写操作。

### Desktop Share 依赖自建原生壳

发布包没有本项目的 Share Extension；官方 preload 未提供 `window.webkit.messageHandlers.dshShare`。`plugins/desktop-share/src/client/index.ts` 在桥接缺失时直接返回，因此“插件可加载”不代表“发送到 DSH”可用。

不能向官方签名 App 注入扩展或修改 ASAR 来补齐。迁移前需要用户决定是否接受暂时缺少系统分享功能，或等待独立扩展方案与官方公开接入点。

## 未验证与本机状态

没有启动官方 GUI进行交互验收；上述阻塞项解决前，不将 Host 测试扩展解释为完整桌面验收。桌宠原生窗口、桌面分享、真实 WeChat / WeCom / AIDEV 账号和 Codex 模型请求未执行。Web Search 的外部流量在夹具中禁用，沿用组件本地协议测试证据。

未退出用户现有 App，未替换本机安装，未迁移真实 profile、会话或凭据，未更改默认应用/协议关联。临时 Host 和 profile 已由测试清理。官方解压包保留在本机临时验证目录，不是已部署安装。
