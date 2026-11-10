# Python / Go / JavaScript 安全复核检查表

## 共通路径

- 认证与授权分开追踪：登录成功是否足以执行当前操作，资源 ID 与当前用户/租户是否绑定；批量接口、导出及后台任务是否重复检查。
- 输入到敏感操作：命令、SQL、模板、HTML、文件路径、反序列化和动态代码；查明实际验证顺序及绕过条件。
- URL/网络：协议和目标主机限制、重定向后的再次校验、内网/回环/元数据地址、超时和响应大小；不能仅凭存在 HTTP 请求判定 SSRF。
- 文件处理：规范化和目录边界、符号链接、压缩包条目、上传后类型和权限、临时文件、大小限制、并发覆盖。
- 会话/凭据：JWT 签名及 issuer/audience/expiry，OAuth state/PKCE/回调，Cookie 属性、CSRF；错误与日志是否泄漏敏感内容。
- 流程：状态转换、重复支付或任务执行、竞态与幂等性；读取与修改之间的授权和一致性。

## Python

- Django/Flask/FastAPI 路由、中间件与对象权限；`raw`/拼接 SQL；模板 `safe`/自动转义绕过。
- `subprocess` 的 shell 模式、`eval/exec`、不可信 pickle/unsafe YAML、文件与归档路径。
- requests/httpx 的 TLS 校验、重定向、代理与 SSRF；生产 debug、异常回显和敏感日志。

## Go

- net/http、Gin、Echo 等路由与中间件顺序；tenant/user 校验与并发 goroutine 中的上下文归属。
- `os/exec` shell 包装、fmt 格式化 SQL、文件路径和 `http.FileServer` 根目录、tar/zip 解包。
- `InsecureSkipVerify`、HTTP client 重定向策略、请求/响应限制；context 取消、goroutine 生命周期和竞态。
- crypto 用法按实际目的判断，不能把所有 MD5/SHA1 非安全用途都报成密码学漏洞。

## JavaScript / TypeScript

- Express/Koa/Nest/Next.js 的服务器路由权限、对象/租户归属与客户端校验的区别。
- `child_process.exec`、eval/Function、模板和 HTML sink；是否存在可靠、上下文匹配的净化。
- 对象合并/动态属性的原型污染、路径与文件服务、JWT 与 Cookie、开放重定向和 SSRF。
- 浏览器 postMessage/原生桥/IPC 的来源与权限边界、CORS、依赖安装脚本、source map 与错误数据暴露。

## 排除误报

检查输入是否为编译期常量、是否仅测试代码、是否不可从不可信入口到达、是否已有参数化/净化/权限控制。缺乏证据时保留待确认，不把代码风格建议提升成漏洞。
