# DSH Pet

`@shamcleren/dsh-pet` 是一个适用于 macOS 的 DeepSeek Harness 标准外部插件。它通过 DSH 的 Cordis Bundle、Host/Client 扩展点和设置系统接入，不修改 DeepSeek Harness 源码或应用壳。

插件把 DSH 会话状态映射为桌面宠物动画和任务卡：普通点击聚焦回原 Harness 会话，点击任务卡聚焦客户端并打开对应会话；拖拽位置、宠物选择和尺寸会持久化。

## 功能

- 会话状态动画：工作中、等待输入、执行失败、结果待查看和空闲。
- 并发任务卡：展示阶段、任务标题、当前摘要、项目/步骤/耗时和下一步动作。
- 点击宠物聚焦回启动它的 Harness 实例，不改变当前会话。
- 点击任务卡聚焦客户端并跳转到对应会话。
- 悬停朝向、点击挥手、拖拽任意摆放；任务卡变化不会移动宠物本体。
- 正常退出前保存最后位置；重启后恢复到同一位置，支持多显示器。
- 在 `Settings → Plugins` 中开关宠物、选择宠物和修改尺寸。
- 开箱内置 5 个本地自定义宠物，也可继续导入其他兼容宠物包。
- 通用 v1/v2 Codex 宠物包解析、校验和缩略图选择。

## DSH 插件结构

这是一个完整的 DSH 外部插件包：

- `package.json#dsh.bundle.patch` 声明 `cordis.patch.yml`。
- Host 入口为 `lib/index.js`，由 `src/index.ts` 构建。
- 浏览器入口为 `lib/client.js`，通过 `package.json#dsh.client` 注入。
- `cordis.patch.yml` 只向组合中插入 `desktop-pet`，不修改上游文件。
- 原生窗口由包内 Swift/AppKit Helper 提供，通过 stdio JSON 协议与 Host 通信。
- 设置、会话事件、WebServer 和工作区导航均使用 DSH/Cordis 扩展点。

详细设计见 [docs/architecture.md](docs/architecture.md)。

## 系统要求

- macOS 12 或更高版本。
- DeepSeek Harness `0.1.6-alpha.2`。DSH 仍处于预发布阶段，升级 DSH 前应重新执行本仓库验证。
- 从源码构建需要 Node.js 22+、pnpm 11 和 Xcode Command Line Tools。
- 发布包内的 Helper 是 `arm64 + x86_64` 通用二进制。

## 宠物资源

插件开箱内置以下 5 个由仓库所有者提供的自定义宠物：

| ID | 显示名称 | 格式 |
| --- | --- | --- |
| `xiaobai` | 小白 | v2，8×11 |
| `xiaobai-no-wave` | 小白·无浪 | v2，8×11 |
| `maltese` | maltese | v2，8×11 |
| `pikachu-local` | pikachu-local | v1，8×9 |
| `xiaohuang_webp` | 线条小狗小黄 | v1，8×9 |

首次启动会把内置包复制到 `DSH_HOME/desktop-pet/packs/`。插件仍会从当前用户的 `~/.codex/pets/` 只读扫描其他合法宠物包；没有安装 Codex 也不影响内置宠物使用。用户也可以自行把有权使用的兼容宠物包放进目标目录。

每个宠物包是一个独立目录：

```text
my-pet/
├── pet.json
└── spritesheet.webp
```

最小 `pet.json`：

```json
{
  "id": "my-pet",
  "displayName": "My Pet",
  "spriteVersionNumber": 2,
  "spritesheetPath": "spritesheet.webp"
}
```

- v1：省略 `spriteVersionNumber` 或设为 `1`，精灵图为 `1536×1872`。
- v2：`spriteVersionNumber` 为 `2`，精灵图为 `1536×2288`。
- `id` 仅允许字母、数字、点、下划线和连字符。

图片资源不属于 MIT 代码许可证，具体边界见 [assets/pets/NOTICE.md](assets/pets/NOTICE.md)。外部导入时请只使用你有权使用的宠物包。

## 从源码构建

```bash
git clone https://gitlab.example.com/shamcleren/dsh-plugin.git
cd dsh-plugin
pnpm install --frozen-lockfile
pnpm --filter @shamcleren/dsh-pet check
```

`pnpm check` 会依次执行 TypeScript 类型检查、单元测试、Host/Client 构建，并编译通用 macOS Helper。构建产物位于 `lib/`。

## 安装到 DeepSeek Harness

先退出使用目标 Profile 的 DeepSeek Harness，然后执行：

在本仓库根目录执行：

```bash
./dhp plugin install dsh-pet
```

也可以直接构建发布包后交给 DSH：

```bash
pnpm --filter @shamcleren/dsh-pet pack --pack-destination artifacts
dsh plugin --profile web add ./artifacts/shamcleren-dsh-pet-0.2.1.tgz
```

也可以在开发期间先执行 `pnpm build`，再把当前目录作为本地插件加入：

```bash
dsh plugin --profile web add "$(pwd)/plugins/dsh-pet"
```

安装或更新后重启 DeepSeek Harness。包内的 `cordis.patch.yml` 会启用插件；无需修改 DSH 源码。

## 配置与数据

静态默认值位于 `cordis.patch.yml`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否启动宠物 |
| `sourceDir` | `~/.codex/pets` | 可选的外部宠物只读导入目录 |
| `petId` | 空 | 自动选择首个合法宠物 |
| `petSize` | `112` | 宠物宽度，范围 80–224 |
| `startQuadrant` | `bottom-end` | 尚无保存位置时的初始象限 |

运行时数据位于 `DSH_HOME/desktop-pet/`：

- `packs/`：已复制的内置包、外部导入包或用户自行放入的宠物包。
- `state.json`：最后屏幕锚点及其坐标语义。

宠物开关、选择和尺寸由 DSH 设置系统保存；插件不保存账号凭据、模型内容或会话正文。

## 开发命令

```bash
pnpm --filter @shamcleren/dsh-pet typecheck
pnpm --filter @shamcleren/dsh-pet test
pnpm --filter @shamcleren/dsh-pet build
pnpm --filter @shamcleren/dsh-pet check
```

## 安全

提交前请先阅读 [SECURITY.md](SECURITY.md)。报告安全问题时不要在公开 Issue 中提交令牌、凭据、私有宠物资源或会话内容。

## 许可证

代码使用 [MIT License](LICENSE)。内置宠物图片会包含在发布包中，但不属于 MIT 代码许可证；详见 [assets/pets/NOTICE.md](assets/pets/NOTICE.md)。

The configuration card is available under **Plugins → this installed bundle** in DSH 0.1.6.
