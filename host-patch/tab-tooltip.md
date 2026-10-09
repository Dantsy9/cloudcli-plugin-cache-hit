# 让标签页的鼠标悬停提示显示「缓存命中率 + 速度」

## 结论

**能改，但提示内容现在是写死的，所以显示实时数字需要改宿主**（2 个文件 + 1 个新组件，约 45 行）。

好消息：宿主的 `Tooltip` 组件的 `content` 类型是 **`ReactNode` 而不是 `string`**，所以提示可以是一个多行的实时读数组件，不需要为它做特殊处理。

---

## 一、现在这条提示从哪来

`src/modules/project-workspace/WorkspaceTabs.tsx`：

```tsx
const displayLabel = tab.kind === 'builtin' ? t(tab.labelKey) : tab.label;   // 第 113 行
...
<Tooltip content={displayLabel} position="bottom">                            // 第 120 行
  <Pill role="tab" aria-label={displayLabel} ...>
```

而 `tab.label` 来自插件的 **manifest**：

```tsx
const pluginTabs: PluginTab[] = plugins
  .filter((p) => p.enabled)
  .map((p) => ({ ..., label: p.displayName, pluginName: p.name, iconFile: p.icon }));  // 第 74-82 行
```

`displayName` 在 `plugin-registry.service.ts:208` 由 `manifest.displayName` 赋值。

**所以提示文字 = 你 `manifest.json` 里的 `displayName`（当前是「缓存命中」）**，一个字都不多。它同时也被当作标签文字用，且标签上有宽度限制（第 129 行 `className="h-8 max-w-44 px-2.5"`、第 140 行 `max-w-28 sm:max-w-36 truncate`）。

`Tooltip` 的类型（`src/shared/ui/Tooltip.tsx:8-14`）：

```ts
type TooltipProps = {
  children: ReactNode;
  content?: ReactNode;        // ← 不是 string，可以是任意节点
  position?: TooltipPosition;
  className?: string;
  delay?: number;             // 默认 350ms
};
```

---

## 二、三条可选路径

| 路径 | 改动 | 提示里能显示什么 | 评价 |
|---|---|---|---|
| **A. 只改 `manifest.json` 的 `displayName`** | 本插件 1 行 | 任意**静态**文字，但**没有数字** | 零成本，但达不到你的目标 |
| **B. 宿主补丁（下文）** | 宿主约 45 行 | **实时**命中率 + 速度 + 明细 | ⭐ 推荐 |
| **C. 插件改写自己的 manifest** | 本插件加写文件 | 数字，但**严重滞后** | ❌ 不推荐，理由见下 |

### 关于路径 C（技术上能，但不该做）

思路是：插件后端子进程有完整文件系统权限，可以定期把实时数字写进自己的 `manifest.json` 的 `displayName`，宿主下次 `scanPlugins()` 就会读到。

但它有三处硬伤：

1. **不会实时更新。** `PluginsContext.tsx` 里 `refreshPlugins()` 只在**挂载时**和安装/卸载/更新/启停插件后调用（第 61-63、70、84、98、121 行），**没有任何定时器**。所以数字要等一次整页刷新或插件操作才会变 —— 对"实时速率"来说等于没有。
2. **标签文字会被截断。** `displayName` 同时是标签文字，被 `max-w-28 sm:max-w-36 truncate` 限制，长文本在标签上只显示前几个字；提示里倒是完整的，但这意味着标签会变得很难看。
3. **破坏只读不变量。** 插件往自己的安装目录（git 工作区）写文件，宿主更新时 `git pull` 可能冲突，而且本插件的测试里明确断言"插件不写任何用户状态"。

---

## 三、宿主补丁（路径 B）

### 3.1 新增 `src/modules/project-workspace/PluginTabTooltip.tsx`

```tsx
import { memo, useEffect, useState } from 'react';

import { api } from '@/shared/api';

type PluginStatus = {
  available: boolean;
  chipText: string;
  detailText: string;
  rateBasis?: 'api-duration' | 'wall-clock' | 'unavailable';
  reason?: string;
};

/** The only plugin that publishes a live status route today. */
const CACHE_HIT_PLUGIN = 'cache-hit';
const POLL_MS = 20_000;

type Props = {
  /** Manifest name of the plugin this tooltip belongs to. */
  pluginName: string;
  /** Absolute path of the selected project, or null when none is open. */
  projectPath: string | null;
  /** The plain tab label — used as-is for every plugin without a status route. */
  fallback: string;
};

/**
 * Live tooltip for a plugin tab.
 *
 * The host's tab tooltip is the manifest `displayName`, which is static, so a
 * plugin cannot put live numbers there on its own. This substitutes a live
 * readout for the plugins that expose a `/status` route and falls back to the
 * plain label for all others — an unknown plugin costs one render and no request.
 *
 * Polling rather than fetching on hover is deliberate: the first `/status` after
 * a transcript changes has to parse the file, and the tooltip only appears after
 * a 350ms hover delay — a box that opens and then stalls is worse than one that
 * is already populated.
 */
function PluginTabTooltip({ pluginName, projectPath, fallback }: Props) {
  const [status, setStatus] = useState<PluginStatus | null>(null);

  useEffect(() => {
    setStatus(null);
    if (pluginName !== CACHE_HIT_PLUGIN || !projectPath) return;

    let cancelled = false;
    let inFlight = false;

    const load = async () => {
      // A hidden tab does not need fresh numbers.
      if (inFlight || document.visibilityState !== 'visible') return;
      inFlight = true;
      try {
        const response = await api.plugins.rpc(
          pluginName,
          'GET',
          `/status?projectPath=${encodeURIComponent(projectPath)}`,
        );
        if (!response.ok) {
          // 404: plugin not installed. 503: its server is not up. Either way the
          // tooltip degrades to the plain label instead of showing an error.
          if (!cancelled) setStatus(null);
          return;
        }
        const data = (await response.json()) as PluginStatus;
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus(null);
      } finally {
        inFlight = false;
      }
    };

    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pluginName, projectPath]);

  if (!status?.available) return <span>{fallback}</span>;

  return (
    <span className="block space-y-0.5 text-left">
      <span className="block font-medium">{fallback}</span>
      <span className="block">{status.chipText}</span>
      <span className="block opacity-80">{status.detailText}</span>
      {/* The rate's denominator is stated here too: an API-duration rate includes
          prefill, and a bare "18 tok/s" invites the reader to assume a peak. */}
      {status.rateBasis && status.rateBasis !== 'api-duration' && (
        <span className="block opacity-70">
          {status.rateBasis === 'wall-clock'
            ? '速率分母为会话跨度（含工具与空闲）'
            : '该 transcript 无法计算速率'}
        </span>
      )}
    </span>
  );
}

export default memo(PluginTabTooltip);
```

### 3.2 `src/modules/project-workspace/WorkspaceTabs.tsx`

**加 prop**（第 13-18 行的类型 + 第 59-64 行的解构）：

```diff
 type WorkspaceTabsProps = {
   activeTab: AppTab;
   setActiveTab: Dispatch<SetStateAction<AppTab>>;
   shouldShowTasksTab: boolean;
   shouldShowBrowserTab: boolean;
+  /** Absolute path of the open project; forwarded to plugin tab tooltips. */
+  projectPath: string | null;
 };
```

```diff
 export default function WorkspaceTabs({
   activeTab,
   setActiveTab,
   shouldShowTasksTab,
   shouldShowBrowserTab,
+  projectPath,
 }: WorkspaceTabsProps) {
```

**替换 Tooltip 的 content**（第 120 行）：

```diff
-            <Tooltip content={displayLabel} position="bottom">
+            <Tooltip
+              content={
+                tab.kind === 'plugin' ? (
+                  <PluginTabTooltip
+                    pluginName={tab.pluginName}
+                    projectPath={projectPath}
+                    fallback={displayLabel}
+                  />
+                ) : (
+                  displayLabel
+                )
+              }
+              position="bottom"
+            >
```

**补 import**：

```diff
 import { usePlugins,PluginIcon } from '@/modules/plugins';
+import PluginTabTooltip from '@/modules/project-workspace/PluginTabTooltip';
```

> 如果 import 顺序触发 lint，把它放到与 `WorkspaceTabs` 同目录其他 import 相邻的位置即可。

### 3.3 `src/modules/project-workspace/WorkspaceHeader.tsx`

`WorkspaceHeader` 已经有 `selectedProject`（第 15 行类型、第 29 行解构），只是没往下传。第 126-131 行：

```diff
               <WorkspaceTabs
                 activeTab={activeTab}
                 setActiveTab={setActiveTab}
                 shouldShowTasksTab={shouldShowTasksTab}
                 shouldShowBrowserTab={shouldShowBrowserTab}
+                projectPath={selectedProject.fullPath || selectedProject.path || null}
               />
```

---

## 四、补丁后的悬停提示

```
┌──────────────────────────────────────┐
│ 缓存命中                              │
│ 缓存命中 53.9% · 18 tok/s             │
│ 4 轮 · 缓存读 58.0M · 新 40.3M         │
└──────────────────────────────────────┘
```

标签文字本身**保持不变**（仍是「缓存命中」），只有悬停提示变丰富 —— 这样标签栏不会被挤乱。

---

## 五、诚实声明

- 上述**行号与代码结构**来自我抓取的 `siteboon/claudecodeui` main 分支源码（`WorkspaceTabs.tsx` 150 行、`WorkspaceHeader.tsx` 162 行、`Tooltip.tsx` 带 `content?: ReactNode`、`PluginsContext.tsx` 无轮询）
- 我**没有在真实运行的 CloudCLI UI 上应用并验证过这个补丁** —— 本机跑不了宿主。它依赖的 `/status` 端点已通过 21 项端到端检查
- 代价：改宿主会**跟随上游更新产生冲突**；如果你希望长期无补丁，值得向上游提一个通用能力：「把插件 tab 的 tooltip 交给插件自己渲染」（即 `Tooltip` 的 content 支持插件提供的组件），这样任何"用量/状态"类插件都能用
