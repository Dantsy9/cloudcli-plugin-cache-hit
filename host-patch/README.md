# 在对话框下方显示「缓存命中」—— 需要宿主侧改动

## 结论先说

**纯插件做不到。** CloudCLI 的插件模型**没有**输入框下方/状态栏的插槽：

| 官方文档明确禁止 | 源码核实 |
|---|---|
| "Appear in the sidebar, toolbar, or status bar — plugins can only live in the tab area" | `ChatComposer.tsx` 里 **0 处** `plugin` 引用；`ChatInterface.tsx` 同样 0 处 |
| "Modify the Chat, Shell, Files, Git, or Tasks tabs" | 插件唯一可达的 UI 是 `PluginTabContent`（`plugin:${name}` 标签路由） |
| "Send messages to Claude — there is no API to interact with the chat or agent" | 插件只有 `api.rpc()` 与 `/plugin-ws/:name`，都无法插入 React 树 |

**但那一行是存在的**，而且宿主目前只显示了 total/input/output，**完全没有缓存信息**：

```
src/modules/chat/composer/ChatComposer.tsx:432
  <PromptInputFooter className="flex-wrap gap-y-1">
    ...
    <TokenUsageSummary usage={tokenBudget} onClick={onShowTokenUsage} />   ← 第 446 行
```

`TokenUsageSummary` 是那个 `<icon> 12.3K tokens` 的 chip，点开走 `/cost` 弹窗；`CostCommandData` 的 `tokenBreakdown` 只有 `input` / `output` 两个字段，**没有 cache 字段**。

所以：把「缓存命中 99%」放进那一行 = 给宿主加约 30 行，数据从本插件的 `/status` 拿。

---

## 方案对比

| 方案 | 改动 | 数据在哪 | 评价 |
|---|---|---|---|
| **A. 保持现状（已交付）** | 0 | 插件自己的标签页 | 零维护，但不在输入框下方 |
| **B. 宿主补丁（下文）** | 宿主 ~30 行 | 输入框下方 chip，点开可跳插件标签页 | 计算口径**完全留在插件里**，宿主只做渲染 |
| **C. 给上游提通用插槽** | 上游 PR | 任意插件都能加状态栏 | 最正确，但要等上游 |
| **D. Claude Code 自己的 statusLine** | 0（改 Claude Code settings） | 只在 **Shell 标签页**里跑 `claude` TUI 时才可见 | 不在 CloudCLI 的 chat 界面里 |

推荐 **B**：插件继续负责全部计算与口径，宿主只加一个渲染 chip。

---

## 方案 B：补丁内容

### 1. 新增 `src/modules/chat/composer/CacheHitSummary.tsx`

```tsx
import { memo, useEffect, useState } from 'react';
import { DatabaseIcon } from 'lucide-react';

import { api } from '@/shared/api';

type CacheHitStatus = {
  available: boolean;
  chipText: string;
  detailText: string;
  reason?: string;
};

type Props = {
  /** Absolute path of the selected project; null when none is selected. */
  projectPath: string | null;
  /** Plugin manifest name. */
  pluginName?: string;
  pollMs?: number;
};

/**
 * Cache-hit chip for the composer footer, fed by the `cache-hit` plugin's
 * `/status` route. Renders nothing when the plugin is not installed or enabled,
 * so this is inert for users who do not use it.
 *
 * All wording comes from the plugin (`chipText` / `detailText`) rather than this
 * component, so the plugin owns its own copy and this stays translation-free.
 */
function CacheHitSummary({ projectPath, pluginName = 'cache-hit', pollMs = 20_000 }: Props) {
  const [status, setStatus] = useState<CacheHitStatus | null>(null);

  useEffect(() => {
    if (!projectPath) {
      setStatus(null);
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const load = async () => {
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const response = await api.plugins.rpc(
          pluginName,
          'GET',
          `/status?projectPath=${encodeURIComponent(projectPath)}`,
        );
        if (!response.ok) {
          // 404 = plugin not installed; 503 = server not running. Either way the
          // chip stays hidden rather than reporting an error the user can't act on.
          if (!cancelled) setStatus(null);
          return;
        }
        const data = (await response.json()) as CacheHitStatus;
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus(null);
      } finally {
        inFlight = false;
      }
    };

    void load();
    const timer = setInterval(load, pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectPath, pluginName, pollMs]);

  if (!status?.available) return null;

  return (
    <span
      title={status.detailText}
      aria-label={`${status.chipText}. ${status.detailText}`}
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border/70 bg-background/70 px-2 text-xs text-muted-foreground shadow-sm sm:gap-2 sm:px-2.5"
    >
      <span className="grid h-5 w-5 place-items-center rounded-md bg-primary/10 text-primary">
        <DatabaseIcon className="h-3.5 w-3.5" />
      </span>
      <span className="font-medium text-foreground">{status.chipText}</span>
      <span className="hidden text-muted-foreground/70 lg:inline">{status.detailText}</span>
    </span>
  );
}

/** Memoized: the composer re-renders on every keystroke and these numbers move per turn. */
export default memo(CacheHitSummary);
```

> 样式直接复用 `TokenUsageSummary` 的类名，视觉上会和 token chip 并排一致。若想点开跳到插件标签页，把它换成 `<button onClick={() => setActiveTab('plugin:cache-hit' as AppTab)}>` 即可。

### 2. `ChatComposer.tsx`：加一个 prop

```diff
   tokenBudget: Record<string, unknown> | null;
   onShowTokenUsage: () => void;
+  /** Absolute path of the selected project, forwarded to the cache-hit chip. */
+  projectPath: string | null;
```

解构处（与 `onShowTokenUsage` 同一个解构块）：

```diff
   onShowTokenUsage,
+  projectPath,
```

渲染处（第 446 行，紧跟 `TokenUsageSummary`）：

```diff
             <TokenUsageSummary usage={tokenBudget} onClick={onShowTokenUsage} />
+
+            <CacheHitSummary projectPath={projectPath} />
```

以及顶部 import：

```diff
 import TokenUsageSummary from '@/modules/chat/composer/TokenUsageSummary';
+import CacheHitSummary from '@/modules/chat/composer/CacheHitSummary';
```

### 3. `ChatInterface.tsx`：把项目路径传下去

`ChatComposer` 目前拿不到项目（它的 props 里没有 `selectedProject`），所以要在 `ChatInterface` 渲染处补一行 —— 该文件已有 `selectedProject`：

```diff
   <ChatComposer
     ...
     tokenBudget={tokenBudget}
     onShowTokenUsage={showCostModal}
+    projectPath={selectedProject?.fullPath || selectedProject?.path || null}
```

（`ChatInterface.tsx:552-553` 是现有的 `tokenBudget` / `onShowTokenUsage` 传递处。）

---

## 数据来源：本插件的 `/status`

补丁只需要一个请求：

```
GET /api/plugins/cache-hit/rpc/status?projectPath=<项目绝对路径>
```

返回（示例）：

```json
{
  "ok": true,
  "available": true,
  "projectPath": "/home/me/proj",
  "sessionId": "6f1c…",
  "turnCount": 4,
  "model": "claude-sonnet-4-5",
  "hitRate": 0.99,
  "cacheRead": 33400000,
  "cacheCreation": 210000,
  "promptTokens": 33700000,
  "newTokens": 1200000,
  "breaks": 0,
  "lostCachedTokens": 0,
  "actualCostUSD": 12.34,
  "savedUSD": 87.65,
  "truncated": false,
  "chipText": "缓存命中 99.0%",
  "detailText": "4 轮 · 缓存读 33.4M · 新 1.2M",
  "updatedAt": 1770000000000
}
```

要点：

- **不返回错误**：没选项目、没 transcript 都返回 `200` + `available:false` + `reason`，轮询方不需要处理异常分支
- **轮询成本低**：分析结果按 `transcript 路径 + mtime + size` 缓存，会话不动时几乎零成本
- `chipText` / `detailText` 是插件预先拼好的文案（插件本身只有中文）；宿主若想自己组织文案，直接用上面的数字字段即可
- 数字口径与插件标签页**完全一致**（同一份 `summarizeSessionFile`），不会出现两处数字对不上

---

## 诚实声明

- 上述 diff 的**行号与结构**来自我抓取的 `cloudcli-ai` / `siteboon/claudecodeui` 当前 main 分支源码（`ChatComposer.tsx` 共 513 行，`TokenUsageSummary` 在第 446 行 etc.）
- 我**没有**在真实运行的 CloudCLI UI 上应用并验证这个补丁 —— 本机跑不了宿主。`/status` 端点本身已通过 19 项端到端检查
- 宿主是 AGPL-3.0 开源，自托管场景下打这个补丁没有许可问题；但**它会跟随上游更新产生冲突**，这是方案 B 的成本

## 更彻底的做法（方案 C）

如果你不想长期维护补丁，值得向上游提一个通用能力：

> 「给插件一个 composer footer 插槽」—— 即 CloudCLI 在 `PromptInputFooter` 里渲染一个 `pluginSlots.footer` 数组，各插件通过 manifest 声明 `slot: "composer-footer"` 并提供一个导出组件。

这样任何"用量/状态"类插件（包括上游已有的 `claude-usage` / `codex-usage` / `glm-usage` / `token-cost-calculator` 推荐列表）都能用，而不是每个都要求用户打补丁。
