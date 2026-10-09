# 缓存命中 · CloudCLI UI 插件

> 分析 Claude Code 会话的 **prompt cache 命中情况**：命中率、逐轮趋势、缓存断裂归因、token 构成与成本节省。

**仓库**：<https://github.com/Dantsy9/cloudcli-plugin-cache-hit>

在 CloudCLI UI 里以独立标签页（tab）的形式展示。计算口径移植自 **cc-haha**（Claude Code 的开源分支）中负责缓存计量的那几个模块，逐条对齐 —— 见 [计算口径](#计算口径)。

## 目录

- [它算什么](#它算什么)
- [安装](#安装)
- [使用](#使用)
- [插件形态：只能用标签页吗？](#插件形态只能用标签页吗)
- [计算口径](#计算口径)
- [后端接口](#后端接口)
- [安全与边界](#安全与边界)
- [开发与测试](#开发与测试)
- [目录结构](#目录结构)

---

## 它算什么

| 指标 | 说明 |
|---|---|
| **加权命中率** | `ΣcacheRead / Σ(input + cacheRead + cacheCreation)`，账单视角：所有被计费的 prompt token 里有多少来自缓存 |
| **平均单轮命中率** | 各轮命中率的算术平均。与加权口径**必然不同**，两者并列展示，不混用 |
| **缓存命中 / 写入 Token** | 读命中量、写缓存量，以及 5m/1h 拆分 |
| **新 Token** | 未缓存输入 + 输出。缓存读**不算**新增消耗 |
| **估算成本** | 实际成本、无缓存反事实成本、净节省、写入溢价 |
| **逐轮趋势图** | 灰柱 = 该轮 prompt 总量，紫柱 = 命中部分，绿线 = 命中率，顶部红块 = 检测到断裂 |
| **缓存断裂 + 归因** | 每一处命中塌陷的原因、丢失的缓存前缀长度、额外成本、以及对应的 transcript 行号 |
| **解析明细** | 每一行 JSONL 被计入或被排除的原因 |
| **多会话汇总** | 按日 / 按模型聚合，以及断裂最多的会话排行（可切"全部项目"） |

---

## 安装

### 从 Git 仓库（推荐）

1. CloudCLI UI → **Settings → Plugins**
2. 在 **Install from Git** 输入框里粘贴：

   ```
   https://github.com/Dantsy9/cloudcli-plugin-cache-hit
   ```

3. 点 **Install**。宿主会自动 `git clone` → `npm install --ignore-scripts` → `npm run build` → 启动后端子进程
4. 安装后**默认已启用**（源码 `plugin-registry.service.ts:218`：`enabled: config[name]?.enabled !== false`）
5. 打开任意项目，标签栏末尾出现「缓存命中」

仓库里**不需要提交 `dist/`** —— 宿主安装时自己编译（已在 `.gitignore`）。

> 安装成本提示：`devDependencies` 里是 `typescript` / `@types/node` / `jsdom`。宿主执行的是普通 `npm install`（不带 `--omit=dev`），因此 jsdom（仅前端测试用，约 37 个包）也会被装上。如果在意安装耗时，删掉它即可，只保留 `analysis.test.mjs` 与 `e2e-server.mjs` 两层测试。

### 本地手工安装

```bash
git clone https://github.com/Dantsy9/cloudcli-plugin-cache-hit.git \
  ~/.claude-code-ui/plugins/cache-hit
cd ~/.claude-code-ui/plugins/cache-hit
npm install
npm run build
```

然后在 Settings → Plugins 里确认已启用。

---

## 使用

打开插件标签页后：

- 顶部选择要分析的会话（默认自动选中**最近修改**的那个，也就是当前活动会话）
- 「单会话分析」看当前会话的逐轮趋势与断裂明细
- 「多会话汇总」看按日聚合，勾选"全部项目"可跨项目统计
- 右上角可开关自动刷新（默认 20 秒；标签页不可见时不发起请求）
- 「重新分析」强制绕过内存缓存重算

### 定位会话的方式

CloudCLI 的 `api.context.session.id` 是**宿主自己的 app 会话 id**，不是 Claude Code 的 transcript id，两者不同。插件因此改用 `api.context.project.path` 推导目录：

```
$HOME/.claude/projects/<项目绝对路径编码>/<会话id>.jsonl
```

编码规则与 Claude Code 及 CloudCLI 宿主完全一致：把 `[A-Za-z0-9-]` 之外的字符全部替换为 `-`。

未显式指定会话时取该目录下 mtime 最新的 `.jsonl`。若指定的会话不存在，会**回退并在页面上明确提示**，不会静默分析成别的会话。

---

## 插件形态：只能用标签页吗？

**是的。在当前 CloudCLI UI 的插件模型下，插件唯一的 UI 出口就是自己的标签页。**

`manifest.json` 的 `slot` 字段目前只接受 `"tab"` —— 文档原话：*Where the plugin appears in the UI. **Currently only `tab` is supported.*** 源码 `plugin-registry.service.ts:214` 是 `slot: manifest.slot || 'tab'`，而 `WorkspaceTabs.tsx` 只用它生成标签项，没有任何其他 `slot` 分支。

### 插件能做的全部

| 能力 | 入口 |
|---|---|
| 一个标签页 UI | `entry` → `mount(container, api)` |
| 一个 Node 后端子进程 | `server` → `dist/server.js`（`127.0.0.1:0` + 就绪信号） |
| 读项目 / 会话上下文 | `api.context`（theme / project / session） |
| 经宿主代理调自己的后端 | `api.rpc()` → `/api/plugins/<name>/rpc/*`（宿主自动鉴权 + 注入 secrets） |
| 实时双向流 | `/plugin-ws/<name>` → 你 server 的 `/ws` |
| 自己的静态资源 | `/api/plugins/<name>/assets/*`（有路径穿越防护） |

### 明确做不到的（架构边界，不是实现取舍）

| 做不到 | 证据 |
|---|---|
| 出现在侧边栏 / 工具栏 / **状态栏** / 输入框下方 | 官方文档逐条明列；`ChatComposer.tsx` 与 `ChatInterface.tsx` 中 `plugin` 出现次数为 **0** |
| 修改内置标签页（Chat / Shell / Files / Git / Tasks） | 同上 |
| 向对话发送消息、充当中间件 | 文档明列，无此 API |
| 与其他插件通信 | 每个插件相互独立 |
| 读用户 auth token / cookie | 宿主统一鉴权，从不暴露 |

**结论：想让缓存数据常驻在对话框下方，必须改动宿主。** 补丁内容、数据来源与维护成本见 [`host-patch/README.md`](host-patch/README.md)，其中对比了三条替代路径：

1. **宿主补丁**（约 30 行，数据仍来自本插件的 `/status`）
2. **给上游提通用 footer 插槽**（最正确，但要等上游）
3. **Claude Code 自己的 `statusLine`**（无需改宿主，但只在 Shell 标签页跑 `claude` TUI 时可见）

> 本插件的 [`/status`](#status为输入框下方的一行准备) 端点就是为路径 1 准备的：一个请求拿到那行需要的全部数字。

---

## 计算口径

以下每条都对应 cc-haha 里的具体实现，并已由 `test/analysis.test.mjs` 逐条钉住。

### 1. 四个 token 桶互斥

`input_tokens` **不包含**缓存 token，所以

```
promptTokens = input + cacheRead + cacheCreation
hitRate     = cacheRead / promptTokens
```

分母用错会系统性高估命中率。cc-haha 在 5 处使用同一公式：`desktop/src/lib/sessionUsageMetrics.ts:58`、`src/utils/forkedAgent.ts:662`、`src/services/compact/compact.ts:1216`、`src/utils/telemetry/perfettoTracing.ts:517`、`desktop/src/components/trajectory/TrajectoryToolbar.tsx:67`。

### 2. 去重（否则数字会翻倍）

一次 assistant 回复的**每个 content block 各写一行 JSONL**，且每一行都重复完整的 `usage` 对象。逐行求和会把真实用量放大约 **2.2 倍**。按 `message.id + requestId` 去重（cc-haha `usageRecordKey()`，`src/utils/usageAccounting.ts:190`），去重行数在"解析明细"里如实展示。

### 3. 必须排除的行

| 行 | 原因 |
|---|---|
| `isSidechain: true` | 子 agent 的轮次，统计的是**子 agent 自己的**上下文 |
| 全零 usage | `<synthetic>` 轮次：中断、API 错误、"No response requested" |
| 带 `forkedFrom` | fork 复制进来的行，那些 API 调用属于源会话 |

### 4. cache_creation 的 5m/1h 拆分优先

`cache_creation` 存在时，聚合字段 `cache_creation_input_tokens` 可能缺失或为 0，先读聚合会静默丢掉全部写入量。cc-haha 两个统计路径都优先用拆分（`transcriptReducer.ts:364`、`stats.ts:149`）。

### 5. 第三方网关的嵌套缓存字段是**包含式**的

OpenAI 兼容的 `input_tokens_details.cached_tokens` / `prompt_tokens_details.cached_tokens` 已包含在 `prompt_tokens` 里，必须**减掉**；而 Anthropic 原生 `cache_*` 字段是**独占式**的，不能再减。移植自 cc-haha `src/server/proxy/transform/usage.ts` 的 `openaiUsageToAnthropic()`，包括它的优先级规则：任何正的直接 `cache_*` 字段优先，因此网关写的 `cache_read_input_tokens: 0` 占位符不会压掉真实的嵌套命中数。

### 6. 不把 99.96% 说成 100%

`99.995%` 会一路进位到 `100.00%`，所以格式化时主动压到 `99.99%`，只有恰好 `rate >= 1` 才显示 `100%`。理由同 cc-haha：对一个"部分命中"的会话显示 100%，是在对用户的账单和 prompt 稳定性说谎。

### 7. 未知模型返回 null，而不是 0

价目表移植自 cc-haha `src/utils/modelCost.ts`。没有公开定价的模型（GLM、DeepSeek、Grok、Kimi……）返回 `null` 并**从成本合计中排除**，而不是按 Claude 价格硬算 —— 那正是 cc-haha 明确拒绝做的事。这类模型以「无定价」徽章标注，token 仍然计入。

### 8. 断裂判定与归因

判定规则与 cc-haha `src/services/api/promptCacheBreakDetection.ts` 一致：

```
cacheRead < prevCacheRead × 0.95   且   prevCacheRead − cacheRead ≥ 2000
```

- **haiku 系列跳过**：缓存行为不同，该规则会产生假阳性（cc-haha `isExcludedModel()`）
- **压缩后的下降跳过**：`compact_boundary` / `microcompact_boundary` 会主动削减消息，缓存下降是预期行为（对应 cc-haha 的 `notifyCompaction()` / `notifyCacheDeletion()`）
- **上一轮本身未命中则跳过**：没有可丢失的前缀

归因顺序：`模型切换` → `1h TTL 过期` → `5m TTL 过期` → `前缀变化` → `疑似服务端` → `未确定`。

### ⚠️ 归因能力的边界（重要）

cc-haha 在**请求发出前**对 system prompt 与工具 schema 做哈希，所以它能指出"是哪个工具的描述变了"。

**插件看不到出站请求。** 它只能用 transcript 能证明的东西：

| 证据 | 能证明什么 |
|---|---|
| `cacheRead` 本身 | 服务端实际复用了多长的前缀 —— 这**是实测值**，据此可定位前缀在何处断开 |
| 时间差 | 是否超过 5 分钟 / 1 小时 TTL |
| `message.model` | 模型是否切换（服务端缓存按模型隔离） |
| prompt 总量变化 | 前缀是否被改动（启发式，阈值 2% 或 500 tokens） |

所以「**前缀变化**」与「**疑似服务端**」的区分是启发式的。这也与 cc-haha 的结论一致：它面对"prompt 未变且间隔 < 5 分钟"的同类情形，同样只给出"大概率服务端路由/驱逐，或计费与推理不一致"的判断，而非确定性结论。页面的「计算口径」折叠区里也向用户说明了这一点。

---

## 后端接口

宿主把 `/api/plugins/cache-hit/rpc/*` 代理到本插件子进程（自动鉴权，不透传 cookie/token）。

| 路由 | 说明 |
|---|---|
| `GET /health` | 进程信息、解析出的 `HOME`、`.claude/projects` 目录、缓存条目数 |
| `GET /projects?home=` | 列出 `~/.claude/projects` 下的项目目录 |
| `GET /sessions?projectPath=&home=` | 列出该项目的 transcript（含"活动"标记） |
| `GET /session?projectPath=&sessionId=&force=&home=` | 单会话完整分析 |
| `GET /overview?projectPath=&all=1&home=` | 跨会话 / 跨项目聚合 |
| `GET /status?projectPath=&sessionId=&home=` | **紧凑单行状态**，供 UI chip 轮询（见下） |
| `GET /clear-cache` | 清空内存缓存 |

错误统一返回 `{ error, code, hint? }`；`/status` 例外 —— 它总是返回 `200` + `available:false` + `reason`，轮询方不必处理"还没选项目"这类异常分支。

### `/status`：为"输入框下方的一行"准备

```json
{
  "available": true, "turnCount": 4, "model": "claude-sonnet-4-5",
  "hitRate": 0.99, "cacheRead": 33400000, "cacheCreation": 210000,
  "promptTokens": 33700000, "newTokens": 1200000,
  "breaks": 0, "lostCachedTokens": 0,
  "actualCostUSD": 12.34, "savedUSD": 87.65,
  "chipText": "缓存命中 99.0%", "detailText": "4 轮 · 缓存读 33.4M · 新 1.2M"
}
```

按 transcript 的 `路径 + mtime + size` 缓存，会话不动时轮询几乎零成本；数字与插件标签页来自同一份分析，不会对不上。

### `home` 参数

宿主启动插件子进程时**只透传有限的环境变量**（`PATH` / `HOME` / `NODE_ENV` / `PLUGIN_NAME`，Windows 上另有若干系统变量），且 Windows 上 `HOME` 可能是空的。插件因此回退到 `USERPROFILE`；如果 Claude Code 的配置目录不在默认位置，可在请求里显式传 `home`（必须是绝对路径，且解析结果被限制在 `<home>/.claude/projects` 内）。

---

## 安全与边界

- 后端**只读**：不开写文件 API，不修改任何用户状态（有测试断言产物里不出现写文件调用）
- 监听 `127.0.0.1:0`，只绑回环
- 所有路径参数都经过绝对路径校验 + 越界检查
- `projectPath` 解析出的目录被强制限制在 `~/.claude/projects` 之下
- 整个插件只在**自己的标签页**里工作：CloudCLI 的插件模型不允许修改内置标签页、不允许向对话发送消息、也没有侧边栏/状态栏插槽
- **想在对话框下方的输入栏里显示"缓存命中 99%"这类常驻一行，纯插件做不到** —— 那需要改动宿主。补丁内容、数据来源与成本分析见 [`host-patch/README.md`](host-patch/README.md)

### 已知限制

- CloudCLI 的插件只能通过文件系统读取 transcript；**读不到宿主的数据库**，因此 `api.context.session.id` 无法直接映射成 transcript id（见上文"定位会话的方式"）
- 超过 48MB 的 transcript 只分析末尾部分，页面会标注"累计数字是最近一段而非全会话"
- Cursor 会话官方不提供 token usage，无法计算；Codex / OpenCode 的 usage 结构与 Claude 不同，当前版本只处理 Claude transcript
- 子 agent（subagent）的用量被排除，不单独成页

---

## 开发与测试

```bash
npm install
npm run build      # tsc -> dist/
npm run dev        # tsc --watch
npm test           # 分析口径 + 前端渲染测试（37 项）
npm run test:e2e   # 真实 server 进程：就绪协议、各路由、错误形状、SIGTERM 关停
```

`npm test` 覆盖两层：

- `test/analysis.test.mjs`（24 项）— 用合成 transcript 钉住上面 8 条口径，断言精确到 token 数与归因顺序
- `test/frontend.test.mjs`（13 项）— 用 jsdom 挂载**编译后**的 `dist/index.js`，配假宿主 `api`，断言用户实际看到的内容；并守住两条硬约束：`dist/index.js` 不得含任何 `import` 语句、卸载后必须释放订阅与定时器

`test/e2e-server.mjs`（19 项）启动真实 `dist/server.js`，把 stdout 重定向到**文件**（而不是管道）来读就绪信号 —— 这既避开沙箱对命名管道的限制，也更贴近宿主逐行读 stdout 的真实做法。

### 验证状态

| 检查 | 结果 |
|---|---|
| `npm run build`（清空 `dist/` 重建） | passed，`tsc` exit 0 |
| `npm test` | passed 37/37 |
| `npm run test:e2e` | passed 19/19 |
| `icon.svg` 过宿主 DOMPurify 清洗 | 已用宿主同款配置实测：6 个图形全部保留、无禁用标签/属性、`currentColor` 生效 |
| 在真实 CloudCLI UI 实例上安装 | **未验证** —— 本地没有可运行的宿主实例 |

### 两条实现约束（改代码前请先读）

1. **前端入口不能有运行时相对 import。** 宿主用 `Blob` URL 动态 `import()` 加载插件前端，而 `blob:` 没有目录概念，`import './x.js'` 无法解析。`src/index.ts` 因此只允许 `import type`（会被 tsc 抹掉），格式化函数在文件内联。有测试专门守这个。
2. **stdout 只能有一行 JSON。** 宿主逐行读 stdout 找 `{"ready":true,"port":N}`，就绪前的任何日志都可能被当成就绪信号。所以本插件所有诊断都走 `console.error`（stderr）。

---

## 目录结构

```
cloudcli-plugin-cache-hit/
├── manifest.json           插件清单（name/displayName/entry/server/icon）
├── package.json            build: tsc；test 脚本
├── package-lock.json       锁定依赖（宿主会执行 npm install）
├── tsconfig.json           ES2020 / ESNext / DOM
├── icon.svg                标签图标（tab 栏 + 设置卡片）
├── src/
│   ├── types.ts            前后端共享的类型（前端只 import type）
│   ├── index.ts            前端：mount / unmount，自包含
│   ├── server.ts           后端：就绪协议 + RPC 路由
│   └── analyze/            计算核心（口径都在这里）
│       ├── usage.ts        usage 归一化、去重键、fork 判定
│       ├── metrics.ts      命中率公式、格式化、成本聚合
│       ├── pricing.ts      价目表（移植自 cc-haha modelCost.ts）
│       ├── breaks.ts       断裂判定与归因
│       ├── transcript.ts   transcript 发现与解析
│       └── summarize.ts    轮次提取、会话汇总、跨会话聚合
├── test/
│   ├── analysis.test.mjs   口径回归测试（24 项）
│   ├── frontend.test.mjs   渲染测试（13 项）
│   └── e2e-server.mjs      真实进程端到端检查（19 项）
└── host-patch/
    └── README.md           在输入框下方显示缓存命中的宿主补丁（可选，需改 CloudCLI UI）
```

---

## License

MIT
