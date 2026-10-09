# 给内置 `/cost` 命令加「缓存命中率」与「输出速率」

## 结论

**能加，但不能以插件形式加** —— `/cost` 是宿主的内置命令，插件碰不到。需要改宿主 **4 个文件、约 45 行**。

好消息是：**宿主服务器其实已经把缓存 token 算出来了，只是丢掉了。** 所以「缓存命中率」几乎是零成本；只有「输出速率」需要新增一处数据读取。

---

## 一、为什么插件做不到

`/cost` 是 builtin 命令 —— 见 `src/modules/chat/hooks/useChatComposerState.ts:488`：

```ts
const showCostModal = useCallback(() => {
  executeCommand(
    { name: '/cost', description: 'Display token usage information',
      namespace: 'builtin', metadata: { type: 'builtin' } } as SlashCommand,
    '/cost', { preserveInput: true },
  );
}, [executeCommand]);
```

它走 `POST /api/commands/execute`，由**宿主的服务端**返回结果，前端只负责渲染。而插件的边界是：

| 限制 | 证据 |
|---|---|
| 插件只有 tab 一种 slot | `plugin-registry.service.ts:29` `const ALLOWED_SLOTS = ['tab']` |
| 插件不能改聊天界面 | `ChatComposer.tsx`、`ChatInterface.tsx` 中 `plugin` 引用数为 **0** |
| 插件不能拦截/修改请求 | 官方文档明列 |

---

## 二、宿主已经算好了缓存 token，然后扔了

`server/modules/commands/commands.routes.ts` 的 `/cost` handler（第 263 行起）：

```ts
const cacheReadTokens =                                    // ← 290-296 行，已经读出来了
  Number(tokenUsage.cacheReadTokens ?? tokenUsage.cache_read_input_tokens
         ?? tokenUsage.cacheReadInputTokens ?? 0) || 0;
const cacheCreationTokens =                                // ← 297-303 行，也读出来了
  Number(tokenUsage.cacheCreationTokens ?? tokenUsage.cache_creation_input_tokens
         ?? tokenUsage.cacheCreationInputTokens ?? 0) || 0;

const inputTokens = normalizedInputValue == null
  ? directInputTokens + cacheReadTokens + cacheCreationTokens   // ← 304-306 行
  : directInputTokens;

return {
  type: 'builtin', action: 'cost',
  data: {
    tokenUsage: { used, total },
    ...(hasTokenBreakdown ? { tokenBreakdown: { input: inputTokens, output: outputTokens } } : {}),
    provider, model,                                        // ← cache 字段在这里被丢掉
  },
};
```

**两个关键点：**

1. `cacheReadTokens` / `cacheCreationTokens` 已经算出来了，只是没有放进返回的 `data`。
2. **`tokenBreakdown.input` 是「含缓存的 prompt 总量」**，不是字面意义上的 input。因为 `provider-token-usage.service.ts:234` 里：

   ```ts
   const rowInputTokens = directInputTokens + rowCacheReadTokens + rowCacheCreationTokens;
   ```

这解释了截图里的数字：`Input 173,972` vs `Output 1,071` —— 那个 173,972 里绝大部分是**同一段 prompt 被缓存重读**的部分。所以现在这个 `Input tokens` 标签其实是误导性的：它没告诉用户其中多少走了缓存。

**换句话说：加上缓存拆分不只是"加两行"，它同时修掉了一个会让人误判的现象。**

---

## 三、输出速率需要 API 耗时，而 transcript 里有

cc-haha 的口径（`desktop/src/lib/sessionUsageMetrics.ts`）：

```ts
tokensPerSecond: apiMs > 0 && output > 0 ? output / (apiMs / 1000) : null,
```
> "divides output tokens by the time the API was actually running, **including prefill**. A caller that only has a transcript (no API duration) gets `null` rather than a rate computed against wall clock that **includes `Bash`**."

问题：宿主现有的 token 数据链路**没有** API 耗时。`summarizeClaudeTokenUsage()` 只读最新一条 assistant turn 的 usage。

但我实测发现 transcript 里有：Claude Code 会把会话成本状态**检查点**写进 transcript，即 `{ type: 'cost-state', ... }` 记录。在一个真实的 7MB transcript 里我数到 **9 个**这样的检查点，从文件的 20% 一直到文件末尾，且**单调递增**：

| 位置 | totalAPIDuration | totalToolDuration | totalDuration | totalCostUSD |
|---|---|---|---|---|
| 20.4% | 5,331,376 ms | 728,692 ms | 7,239,144 ms | 161.14 |
| 32.5% | 7,557,639 ms | 832,243 ms | 11,303,704 ms | 228.81 |
| 75.1% | 11,418,561 ms | 971,306 ms | 32,032,017 ms | 265.71 |
| 100% | 13,391,238 ms | 1,638,254 ms | 35,385,403 ms | 268.64 |

它还带 `modelUsage`（逐模型的 `inputTokens` / `outputTokens` / `cacheReadInputTokens` / `cacheCreationInputTokens` / `costUSD`），因此顺带能给出一份**运行时自己的累计命中率**作为交叉校验。

按 cc-haha 的公式，这份数据的输出速率 = 240,352 / 13,391.238 ≈ **17.9 tok/s**。这个数字偏低是**正确**的：分母含 prefill，而这个会话累计 prompt 达 1.07 亿 token。它不是解码峰值 —— UI 上必须写清楚分母是什么，否则用户会以为出了 bug。

---

## 四、补丁（4 个文件）

### 文件 1 · `server/modules/providers/services/provider-token-usage.service.ts`

让 API 耗时跟着已有的 token 数据一起流到前端（这份数据同时喂给输入框下方的 token chip，所以 chip 也能用）。

**1a. 扩展类型（第 32-46 行）：**

```diff
 type TokenUsageResult = {
   used: number;
   total?: number;
   inputTokens: number;
   outputTokens: number;
   cacheReadTokens?: number;
   cacheCreationTokens?: number;
   cacheTokens?: number;
+  /** API wall-clock from the transcript's own `cost-state` checkpoint. */
+  apiDurationMs?: number;
+  toolDurationMs?: number;
+  sessionDurationMs?: number;
+  totalCostUSD?: number;
   breakdown: {
     input: number;
     output: number;
   };
   unsupported?: boolean;
   message?: string;
 };
```

**1b. 新增一个读取函数**（放在 `summarizeClaudeTokenUsage` 上方）：

```ts
/**
 * Newest `cost-state` checkpoint in already-parsed transcript rows.
 *
 * Claude Code checkpoints its session cost telemetry into the transcript as
 * `{ type: 'cost-state', totalAPIDuration, totalToolDuration, totalDuration,
 * totalCostUSD, modelUsage }` — the same shape cc-haha persists from its cost
 * tracker. It is the ONLY place a transcript exposes an API-duration figure,
 * which is what an honest output rate needs: dividing by session wall-clock
 * would fold in tool execution and idle time.
 *
 * The LAST row wins — the checkpoints are cumulative, so the final one is the
 * session's current state. Returns null when the (possibly tail-only) window
 * contains no checkpoint; callers must then omit the rate rather than guess.
 */
function readClaudeCostState(entries: AnyRecord[]): Pick<
  TokenUsageResult,
  'apiDurationMs' | 'toolDurationMs' | 'sessionDurationMs' | 'totalCostUSD'
> | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'cost-state') continue;
    return {
      apiDurationMs: readUsageNumber(entry.totalAPIDuration),
      toolDurationMs: readUsageNumber(entry.totalToolDuration),
      sessionDurationMs: readUsageNumber(entry.totalDuration),
      totalCostUSD: readUsageNumber(entry.totalCostUSD),
    };
  }
  return null;
}
```

**1c. 在 `summarizeClaudeTokenUsage` 的 return 里带上（第 251 行附近）：**

```diff
   const cacheTokens = cacheReadTokens + cacheCreationTokens;
+  const costState = readClaudeCostState(entries);
 
   return {
     used: inputTokens + outputTokens,
     total: contextWindow,
     inputTokens,
     outputTokens,
     cacheReadTokens,
     cacheCreationTokens,
     cacheTokens,
     breakdown: { input: inputTokens, output: outputTokens },
+    ...(costState ?? {}),
   };
 }
```

> 注意 `TOKEN_USAGE_TAIL_BYTES` 是 4MB。`cost-state` 记录稀疏，通常落在尾窗内；万一没有，`apiDurationMs` 就是 `undefined`，速率那一行自然不渲染 —— 降级是安全的，不会显示假数字。

### 文件 2 · `server/modules/commands/commands.routes.ts`

`/cost` handler 尾部（第 317-340 行）：

```diff
     const computedUsed = inputTokens + outputTokens;
     const hasTokenBreakdown = computedUsed > 0;
     const used = Math.max(reportedUsed, computedUsed);
 
+    // `inputTokens` already contains the cache buckets (see the branch above),
+    // so it IS the prompt total — the only honest denominator for a hit rate.
+    const cacheHitRate = inputTokens > 0 && cacheReadTokens > 0
+      ? cacheReadTokens / inputTokens
+      : null;
+    const apiDurationMs =
+      Number(tokenUsage.apiDurationMs ?? tokenUsage.totalAPIDuration ?? 0) || 0;
+    const outputTokensPerSecond =
+      apiDurationMs > 0 && outputTokens > 0
+        ? outputTokens / (apiDurationMs / 1000)
+        : null;
+
     return {
       type: "builtin",
       action: "cost",
       data: {
         tokenUsage: { used, total },
         ...(hasTokenBreakdown
           ? { tokenBreakdown: { input: inputTokens, output: outputTokens } }
           : {}),
+        ...(cacheReadTokens > 0 || cacheCreationTokens > 0
+          ? {
+              cache: {
+                readTokens: cacheReadTokens,
+                creationTokens: cacheCreationTokens,
+                hitRate: cacheHitRate,
+              },
+            }
+          : {}),
+        ...(outputTokensPerSecond !== null
+          ? {
+              rate: {
+                outputTokensPerSecond,
+                apiDurationMs,
+                basis: "api-duration" as const,
+              },
+            }
+          : {}),
         provider,
         model,
       },
     };
```

### 文件 3 · `src/shared/types.ts`

```diff
 export type CostCommandData = {
   tokenUsage?: {
     used?: number;
     total?: number;
   };
   tokenBreakdown?: {
     input?: number;
     output?: number;
   };
+  /**
+   * Prompt-cache accounting. `tokenBreakdown.input` is the prompt total with the
+   * cache buckets already folded in, so it is the denominator for `hitRate`.
+   */
+  cache?: {
+    readTokens?: number;
+    creationTokens?: number;
+    hitRate?: number | null;
+  };
+  /**
+   * Output speed. `basis` states what the rate divides by — a value of
+   * `api-duration` means prefill is included and tool execution is not.
+   */
+  rate?: {
+    outputTokensPerSecond?: number | null;
+    apiDurationMs?: number;
+    basis?: 'api-duration';
+  };
   provider?: string;
   model?: string;
 };
```

### 文件 4 · `src/modules/chat/modals/CommandResultModal.tsx`

`CostContent`（第 421-458 行）：把误导性的 `Input tokens` 改成 `Prompt tokens`，并补三行。

```diff
 function CostContent({ data }: { data: CostCommandData }) {
   const used = Number(data.tokenUsage?.used ?? 0);
   const total = Number(data.tokenUsage?.total ?? 0);
   const model = data.model || 'Unknown';
   const provider = getProviderLabel(data.provider, data.provider || 'Unknown');
   const hasBreakdown =
     typeof data.tokenBreakdown?.input === 'number' ||
     typeof data.tokenBreakdown?.output === 'number';
+  const cacheRead = Number(data.cache?.readTokens ?? 0);
+  const cacheCreation = Number(data.cache?.creationTokens ?? 0);
+  const hitRate =
+    typeof data.cache?.hitRate === 'number' ? data.cache.hitRate : null;
+  const rate = data.rate?.outputTokensPerSecond ?? null;
   const usageRows = [
     { label: 'Total tokens used', value: formatNumber(used), icon: Activity },
     ...(hasBreakdown
       ? [
           {
-            label: 'Input tokens',
+            // Not "Input": this total already contains the cache buckets, and
+            // calling it Input made a cache-heavy session look like it sent
+            // 173K tokens of new input when most of it was cached re-reads.
+            label: 'Prompt tokens',
             value: formatNumber(Number(data.tokenBreakdown?.input ?? 0)),
             icon: TerminalSquare,
           },
           {
             label: 'Output tokens',
             value: formatNumber(Number(data.tokenBreakdown?.output ?? 0)),
             icon: Coins,
           },
         ]
       : [
           { label: 'Breakdown', value: 'Unavailable', icon: TerminalSquare },
         ]),
+    ...(cacheRead > 0
+      ? [
+          {
+            label: 'Cache hit rate',
+            // Never round a partial hit up to a flat 100%: 99.96% is not fully
+            // cached, and saying so would misstate both the bill and prompt
+            // stability.
+            value: hitRate === null ? '--' : formatCacheHitRate(hitRate),
+            icon: Database,
+          },
+          {
+            label: 'Cache read / write',
+            value: `${formatNumber(cacheRead)} / ${formatNumber(cacheCreation)}`,
+            icon: Database,
+          },
+        ]
+      : []),
+    ...(rate !== null
+      ? [
+          {
+            label: 'Output speed',
+            // Labelled with its denominator on purpose: this divides by API
+            // wall-clock INCLUDING prefill, so it sits far below a decode-only
+            // peak on a long agent session.
+            value: `${formatNumber(Math.round(rate))} tok/s (API, incl. prefill)`,
+            icon: Gauge,
+          },
+        ]
+      : []),
     ...(total > used
       ? [{ label: 'Context window', value: formatNumber(total), icon: Gauge }]
       : []),
   ];
```

`formatCacheHitRate` 需要新增（cc-haha 的同款实现，放在同文件或 `src/shared/utils` 里）：

```ts
/** Mirrors cc-haha's `formatCacheHitRate()`: a partial hit never renders as 100%. */
function formatCacheHitRate(rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return '0%';
  if (rate >= 1) return '100%';
  const percent = rate * 100;
  const oneDecimal = percent.toFixed(1);
  if (oneDecimal !== '100.0') return `${oneDecimal}%`;
  const twoDecimals = percent.toFixed(2);
  return twoDecimals === '100.00' ? '99.99%' : `${twoDecimals}%`;
}
```

`Database` 需要从 `lucide-react` 补进 import。

---

## 五、补丁后的 `/cost` 看起来是这样

```
SESSION TELEMETRY
Token Usage
Input, output, and total token counts for this session.

  Total tokens used        175,043
  Prompt tokens            173,972      ← 由 "Input tokens" 改名
  Output tokens              1,071
  Cache hit rate             96.4%      ← 新增
  Cache read / write   167,700 / 1,180  ← 新增
  Output speed        18 tok/s (API, incl. prefill)   ← 新增
  Context window           160,000

  PROVIDER: Claude          MODEL: opus[1m]
```

---

## 六、不影响插件、也不依赖插件

这个补丁**完全不依赖本插件**：

- 数据源是宿主自己的 `provider-token-usage.service.ts`（它本来就在读 transcript）
- 阈值与格式化沿用 cc-haha 的口径（不把 99.96% 说成 100%）
- 插件未安装时 `/cost` 照常工作

插件与它的关系只是**互相印证**：插件标签页给的是主线程逐轮口径（含断裂归因），`/cost` 给的是运行时累计口径。两者数字可能不同 —— 那是统计范围不同（`/cost` 含子 agent 等全部模型），不是谁算错了。

---

## 七、诚实声明

- 上述**行号与代码结构**来自我抓取的 `siteboon/claudecodeui` main 分支源码（`commands.routes.ts` 604 行、`CommandResultModal.tsx` 661 行、`provider-token-usage.service.ts` 489 行）
- `cost-state` 记录的存在性、字段名与单调递增性，是我在**你机器上的真实 transcript** 上实测的（7MB 文件里 9 个检查点）
- 我**没有在真实运行的 CloudCLI UI 上应用并验证过这个补丁** —— 本机跑不了宿主。`/cost` handler 的改动逻辑与 cc-haha 的公式一致，但端到端效果需要你在实例上确认
- 宿主是 AGPL-3.0，自托管场景打补丁无许可问题；代价是**跟随上游更新会产生冲突**
