# rpiv-advisor-local — 个人维护说明

> **要升级上游？直接看 [`UPGRADING.md`](UPGRADING.md)。**
> 本文是设计理由与改动规格的**背景资料**，不是操作手册。
> AI 工作须知在 [`AGENTS.md`](AGENTS.md)；文件分类清单在
> [`.upstream/MANIFEST.md`](.upstream/MANIFEST.md)。

基于 `@juicesharp/rpiv-advisor` **2.13.8** 的本地 fork，加入 **advisor 侧调用跨账号故障转移**。
放在 `~/.pi/agent/local-plugins/rpiv-advisor-local/`，通过 `~/.pi/agent/settings.json`
本地包路径加载。**上游升级靠手动重放补丁**，流程见 `UPGRADING.md`。

当前版本：**2.13.8-personal**

> **升级记录**：原基于 2.10.1。2026-10-17 把上游 2.13.8 的两项成果并入本 fork ——
> 详见下文「上游 2.13.8 并入记录」。

---

## 上游 2.13.8 并入记录（2026-10-17）

从 2.10.1 升到 2.13.8，上游一共只动了 **5 个文件**（其余逐字节相同）：

| 文件 | 改动 | 处理 |
|---|---|---|
| `advisor/context.ts` | **新增 `stripToolDeclarations()`** — 剔掉 system 消息里的 `toolsAdded`/`toolsRemoved` | 整文件取上游 |
| `advisor/index.ts` | 转导出新函数 | 整文件取上游 |
| `advisor/execute.ts` | 分支管线改为 `stripInflightAdvisorCall(stripToolDeclarations(convertToLlm(...)))` | **手工重做**到本 fork 的补丁之上 |
| `docs/tool-reference.md` | 文档同步 | 整文件取上游 |
| `package.json` | `typebox` 从 `dependencies` 挪到 `peerDependencies:"*"` | 本 fork 的 `package.json` 与内嵌 `rpiv-config` 同步 |

### 为什么要 stripToolDeclarations（#295）

Pi >= 1.0 会把执行体的 system prompt 与工具清单**以 `system` 消息形式记进 transcript**，
provider 从这些 `toolsAdded`/`toolsRemoved` **增量**里解析本次请求可用的工具。
所以只传 `tools: []` **不等于**「advisor 没有工具」——执行体的工具依然可调用，
advisor 会以 `stopReason: "toolUse"` 且**无文本**结束。

> **与本 fork 的交互（重要）**：这种「无文本终止」正好落在本 fork 的
> R6.4 空响应分支上。修好之前，advisor 会：同账号重试一次 → 仍为空 →
> 报 `ERR_EMPTY_RESPONSE`。合并 #295 后这条路径不再被误触发。
> 两项修复互相独立、方向一致，不是重复劳动。

### 为什么 typebox 必须是 peerDependency

Pi 会把裸标识符 `typebox` **别名到它自己捆绑的那份**。manifest 里再装一份，
轻则死重、重则产生**第二个运行时实例**（两个 `Type.Object` 不是同一个对象，
跨实例校验会静默失败）。Pi 0.99.1 起每个启动都会告警：

```
Host-provided extension packages must be declared in peerDependencies with a "*" range, not dependencies: typebox.
```

本 fork 已按此修正：`package.json` 与内嵌 `node_modules/@juicesharp/rpiv-config` 都改为 peer，
并**删除了本地 `node_modules/typebox`**。宿主清单（`HOST_PROVIDED_EXTENSION_PACKAGES`）
同时包含 `typebox` 与 `@sinclair/typebox`。

> ⚠️ 删掉本地 typebox 后，`run-tests.mjs` 改为从**宿主**取 typebox
> （`HOST_CA/node_modules/typebox`），仅当宿主没有时才回退到本插件的副本。
> 宿主的那份是 Pi 实际别名的那一个，测的才是真实解析结果。

---

## ★ 已知的两个历史遗留问题（与本次合并无关，但会让 advisor 形同虚设）

### 问题 1 — ★★ 真因：`"extensions": []` 把本地包**整个关掉了**（本 fork 此前从未生效）

原先的写法是**对象形式 + 空数组**：

```json
{
  "source": "./local-plugins/rpiv-advisor-local",
  "extensions": [],
  "skills": [],
  "prompts": [],
  "themes": []
}
```

**直觉上「空数组 = 不过滤」，实际相反：空数组是一个匹配不到任何东西的过滤器，结果是该包不加载任何资源。**

Pi 的 `collectPackageResources()` 分派逻辑（实测反推）：

```js
if (filter2) {
  for (let resourceType of RESOURCE_TYPES) {
    let patterns = filter2[resourceType], target = ...;
    filter2.autoload === false
      ? this.applyPackageDeltaFilter(packageRoot, patterns ?? [], ...)
      : patterns !== void 0
        ? this.applyPackageFilter(packageRoot, patterns, ...)   // ← 空数组走这里
        : this.collectDefaultResources(...);                    // ← 只有缺省才默认全载
  }
  return true;
}
```

`patterns = []` 是 `!== undefined`，所以走 `applyPackageFilter`，而其 `userPatterns.length === 0` 分支把每个文件都标为 `enabled = false`。

**对照实验（同一台机、同一时刻，只改这一个字段）**：

| 条目写法 | `advisor` 是否注册 |
|---|---|
| 对象 + `"extensions": []` | **false**（45 个工具，无 advisor） |
| 纯字符串 `"./local-plugins/rpiv-advisor-local"` | **true**（46 个工具，含 advisor，且 active） |

**这意味着一个很尴尬的结论**：本 fork 自放下那天起**从来没有被加载过**。
之前能用的 advisor 一直是 `packages[27]` 的 **npm 2.13.8**（它是纯字符串，能正常加载）。
所以此前「failover 在工作」的说法不成立 —— 真因就是这次查出来的。

> 先前的误判（保留备查）：曾以为「两个包都加载、靠 first-wins 取前一个」。
> 实测推翻：`dedupePackages()` 确实不折叠这两个身份，但**本地那个根本没进到工具注册阶段**，
> 因为它在「收集资源」阶段就被空过滤器清空了，根本轮不到 first-wins。

**处理（已执行）**：

1. `packages[8]` 改为**纯字符串** —— 让 manifest 的 `pi.extensions` 生效（见下文）。
2. `packages[27]` 的 `"npm:@juicesharp/rpiv-advisor"` **已删除**，避免重复注册；
   npm 目录**保留**作升级比对基准（见 `.upstream/`）。

```json
"./local-plugins/rpiv-advisor-local",
```

> ⚠️ **以后给本地包加条目，一律用纯字符串，不要用带空数组的对象形式。**
> 要逐项开关资源才用数组，且里面必须写出**真正想启用的模式**，写成 `[]` 等于关掉一切。
> （顺带纠正一个误读：`pi list` 里的 `(filtered)` 只表示「条目是对象形式」，**不**表示被跳过。）

**验证方法**（以后排障可直接复用）—— 用一次性探针读真实工具表：

```ts
// /tmp/probe.ts
export default function (pi: any) {
  pi.on("session_start", async () => {
    const adv = pi.getAllTools().find((t: any) => t.name === "advisor");
    console.error(adv ? "advisor REGISTERED: " + JSON.stringify(adv.sourceInfo)
                      : "advisor NOT REGISTERED");
  });
}
```

```bash
pi -p --mode text --no-session -e /tmp/probe.ts "say OK" 2>&1 | grep advisor
```

`sourceInfo.path` 会直接告诉你**到底是哪个包**在供货 —— 不要靠猜。

### 问题 2 — 配置的 advisor 模型根本不存在，advisor 已被自动停用

```
~/.config/rpiv-advisor/advisor.json
  modelKey = "magpie/codex/gpt-6.1-sol"
```

`magpie` 是本地路由代理（`127.0.0.1:3425`），它对外只暴露 7 个模型：

```
group/smart-split            group/auto-step-5-preview    4-1/deepseek-v4.1-flash
group/auto-deepseek-v4-1-flash   4-1/step-5-preview       gemini/gemini-3.8-flash
cline/cline-pass/deepseek-v4.1-flash
```

**没有 `codex/gpt-6.1-sol`**。`restoreAdvisorState()` 走
`modelRegistry.find("magpie", "codex/gpt-6.1-sol")` → `undefined` → **`deactivate()`**：
清空选中模型、把 `advisor` 从活动工具集里摘掉、并在有 UI 时提示
`Previously configured advisor model ... is no longer available`。

**实测**：`pi -p` 列出的工具里**没有 `advisor`**，system prompt 里也没有
`Escalate to a stronger reviewer ...` 这段 promptSnippet。

**处理（二选一）**：

```bash
# A. 把 advisor 指到真实存在的模型（推荐先用这个验证链路）
#    注意 magpie 只有 group/* 与 gemini/*，要 gpt-6.1-sol 就得换 provider：
#    openai-codex/gpt-6.1-sol  或  openai-codex-account-2/gpt-6.1-sol
#    交互式：/advisor

# B. 让 magpie 补上 codex 路由（需改代理自身配置，不在本插件范围内）
```

> **顺带说明**：`magpie` 的 provider 名不含 `-account-<N>`，`advisorFamily("magpie") === "magpie"`，
> 所以**即使模型存在，failover 也是单候选（INERT）**，与上游行为完全一致。
> 要让 failover 真正生效，advisor 必须指向**有兄弟账号槽的 provider**，
> 例如 `openai-codex`（兄弟 = `openai-codex-account-2`，实测候选链长度 2）。
> 这与「问题 2」的 A 方案一并解决。

---

## 为什么要做这个 fork

`advisor` 工具的调用走 pi-ai 的 `completeSimple()` **直连 provider**，不经过 Pi 的 agent 循环，
因此**不产生** `message_end` / `assistant_error` 事件。后果是：

> `pi-multi-account`（账号轮换插件）**完全看不见 advisor 的失败**，不会为它切换账号。

实测证据：两次 advisor 失败（provider 返回的额度耗尽错误）在该插件的
`provider-failover-debug.log` 里**零条目**。也就是说，一个账号耗尽就会让 advisor 直接挂掉，
而旁边健康的备用账号完全用不上。

本 fork 补上这一层：**同一个模型 id 在兄弟账号上重试**。

---

## 改动内容 — 「同模型跨账号重试」完整规格

> 这一节是**唯一权威的补丁定义**。上游升级时按这里的表重做，并用
> `node check-upstream-merge.mjs` 验收（见下）。

### 为什么加这个补丁（动机，不是猜测）

advisor 的调用走 pi-ai 的 `completeSimple()` **直连 provider**，不经过 Pi 的 agent 循环，
因此**不产生** `message_end` / `assistant_error` 事件。后果：

> `pi-multi-account`（账号轮换插件）**看不见 advisor 的失败**，不会为它切换账号。

一个账号耗尽就让 advisor 直接挂掉，旁边的备用账号完全用不上。

本补丁补上这一层：**同一个 model id 在兄弟账号上重试**。

---

### 改动 A：新增 `advisor/fallback.ts`（上游没有这个文件）

这是 fork 独有文件，上游升级的 `cp *.ts` **不会覆盖它**。除非上游改了被引用的导出名，
否则这个文件**几乎不用动**。

| 导出 | 作用 |
|---|---|
| `advisorFamily(provider)` | `openai-codex-account-2` → `openai-codex`。**只认 `-account-<N>` 约定**，其它同名前缀不合并 |
| `isSiblingProvider(provider, family)` | 是否同族。**双向**：base 配成 primary 时编号 slot 是兄弟；编号 slot 配成 primary 时 **base 也是兄弟**（最常见，因为耗尽的往往是 base） |
| `buildAdvisorCandidates(available, primary)` | 生成候选链 `[primary, ...siblings]`，按 slot 序号排序，按 provider 去重 |
| `isRetryableAdvisorError(msg)` | **窄口径**失败分类器（见改动 C） |
| `errAllCandidatesFailed(failures)` | 全链失败时聚合每次尝试 |

---

### 改动 B：`advisor/execute.ts` — 四处必改

这是升级时**唯一需要手工重做**的文件。共 8 个 hunk，分四类：

#### B1. 引入 fallback

```ts
import {
	type AdvisorAttemptFailure,
	buildAdvisorCandidates,
	errAllCandidatesFailed,
	isRetryableAdvisorError,
} from "./fallback.js";
```

同时从 `./messages.js` 的导入里**去掉 `errNoApiKey`**（改成按候选处理），**加上 `ERR_UNKNOWN`**。

#### B2. 把「单次调用」改成「候选链循环」

上游原有结构（**必须拆掉**）：

```ts
// 上游：进循环前一次性解析凭据 + 一次性守卫
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(advisor);
if (!auth.ok) return buildErrorResult(...);
if (!auth.apiKey && !runtimeCompleteSimple) return buildErrorResult(...);
```

改成：

```ts
const available = ctx.modelRegistry.getAll?.() ?? [];
const candidates = buildAdvisorCandidates(available, advisor);
const failures: AdvisorAttemptFailure[] = [];

for (const candidate of candidates) {
	const label = `${candidate.provider}:${candidate.id}`;

	if (signal?.aborted) return buildErrorResult(label, effort, ERR_CALL_ABORTED, ERR_ABORTED_DETAIL);

	// ★ 凭据必须在循环内、按候选解析
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate);
	if (!auth.ok) { failures.push({ label, stage: "credentials", reason: auth.error }); continue; }
	if (!auth.apiKey && !runtimeCompleteSimple) {
		failures.push({ label, stage: "credentials", reason: errNoApiKeyDetail(candidate.provider) });
		continue;
	}
	...
}
```

**候选链无关的工作必须提到循环外**：`buildSessionContext()`、`convertToLlm()`、
`getInventoryMessage(pi.getAllTools())`、`loadCompleteSimple()`。提到循环外有两个理由：
(a) 每次重建有分叉风险，(b) 纯浪费。

#### B3. 每次尝试内部：判定顺序（**最易错**）

```ts
let response: AssistantMessage;
try {
	response = await callAdvisor();
} catch (err) {
	const message = err instanceof Error ? err.message : String(err);
	if (isRetryableAdvisorError(message)) {
		failures.push({ label, stage: "threw", reason: message });
		continue;                                  // 账号拒绝 → 换下一个
	}
	return buildErrorResult(label, effort, errCallThrew(message), message);  // 传输/编程错误 → 不换
}

// ★★ 判定顺序：aborted -> error -> 空响应。顺序错了会静默降级错误信息。
if (response.stopReason === "aborted") return buildAdvisorResult({ ...advisorLabel: label... });
if (response.stopReason === "error") {
	const message = response.errorMessage;
	if (isRetryableAdvisorError(message)) {
		failures.push({ label, stage: "call", reason: message ?? ERR_UNKNOWN });
		continue;
	}
	return buildAdvisorResult({ ...advisorLabel: label... });
}

// 到这里才是 R6.4 空响应重试：同账号重试一次，绝不跨账号
let advisorText = advisorTextFromResponse(response);
if (!advisorText) {
	try { response = await callAdvisor(); }
	catch (err) { return buildErrorResult(label, effort, errCallThrew(String(err)), String(err)); }
	const retryTerminal = stopReasonEnvelope(response, label, effort);
	if (retryTerminal) return retryTerminal;
	advisorText = advisorTextFromResponse(response);
	if (!advisorText) return buildAdvisorResult({ text: ERR_EMPTY_RESPONSE, advisorLabel: label, ... });
}
return buildAdvisorResult({ text: advisorText, advisorLabel: label, ... });
```

关键点：

- **`advisorLabel` 全部改成 `label`** —— `details.advisorModel` 必须报**真正应答的那个候选**，
  不是配置的 primary。这是判断 failover 是否发生的唯一观测点。
- 空响应重试**不跨账号**（未解释的空输出不是账号故障），预算**按候选重置**，
  且**无外层循环乘倍**。
- 每次尝试前重查 `signal?.aborted`：abort 后不该再发起计费请求。

#### B4. 收尾：聚合 + 单候选保持原文案

```ts
const aggregate =
	failures.length === 1 ? singleFailureText(failures[0]) : errAllCandidatesFailed(failures);
return buildErrorResult(advisorLabel, effort, aggregate, aggregate);
```

`singleFailureText()` 与 `stopReasonEnvelope()` 是本 fork 新增的两个**模块级函数**（提到
`executeAdvisor` 之外），因为它们在循环里被多处调用。上游若把 `stopReasonEnvelope`
写成内联闭包，需要重新提取。

---

### 改动 C：审阅分类器（`fallback.ts` 内的正则表）

**窄口径是硬约束。** 裸词 `insufficient` / `expired` / `capacity` / `billing` 会误判：

| 误判源 | 为什么不该换账号 |
|---|---|
| `insufficient context capacity` | 上下文不够，换账号一样不够 |
| `expired request deadline` | 请求超时，传输问题 |
| `service capacity` / `503` / `overloaded` | **服务故障，换账号无用** |
| `unsupported billing configuration` | 配置问题 |

所以每个模式都必须是**多词**或**凭据特有**的。HTTP 状态码用 `new RegExp("\\b401\\b")`
形式构造，避免转义层把它弄乱。

---

### 改动 D：`package.json`

- `version` 改为 `<上游版本>-personal`
- **`typebox` 必须在 `peerDependencies: "*"`，不能在 `dependencies`**（上游 2.12.0 起）
- `@juicesharp/rpiv-config` 跟上游同版本

### 改动 E：按会话显式授权（advisor 默认关闭）

**行为**：每个 session 默认**不激活** advisor，直到用户在该会话的提示词里明确要求使用它。
授权只属于当前会话，进程重启或新会话即回到关闭。

| 触发 | 结果 |
|---|---|
| `调用 advisor` / `请 Advisor 指导一下` / `让 advisor 看看` / `启用 advisor` | 本会话开启 |
| `call the advisor` / `use advisor` / `ask advisor to ...` | 本会话开启 |
| 手动执行 `/advisor` 选模型 | 本会话开启（选 No advisor 则撤销） |
| `不要调用 advisor` / `别用 advisor` / `don't call the advisor` | **不开**（否定检测） |
| `advisor 是什么？` / `advisor 太慢了` / `上次 advisor 说了什么` | **不开**（非祈使） |
| 新 session / 进程重启 | 回到关闭 |

**实现**（4 处，缺一不可）：

1. `advisor/session-optin.ts`（新增）—— `detectOptInRequest()` 关键词检测 +
   `Set<string>` 按 session id 存授权。
2. `advisor/handlers.ts` —— `reconcileAdvisorTool()` 里 `blocked || !isSessionOptedIn(sessionId)`，
   让**所有**调用方（4 处）自动继承这道门；新增 `registerInputOptInHandler()` 在
   `input` 阶段授权，使**同一轮**的 `before_agent_start` 就能看到已开启。
3. `advisor/restore.ts` —— `session_start` 先 `resetSessionOptIn()`，再走原有恢复逻辑
   （同时把末尾的直接 `setActiveTools` 改为走 reconcile，否则会绕过门）。
4. `index.ts` —— 注册 input hook，且**必须在 `before_agent_start` 之前**。

**两个易错点**：

- `input` hook 必须返回 `{ action: "continue" }`，**不能 `transform`**。改写用户输入会和
  其他扩展的 input handler 打架（本机 `security-audit-interceptor` 也挂了 input hook）。
- 授权必须在 `input` 阶段完成。若只在 `before_agent_start` 里判断，用户说"调用 advisor"
  的那一轮 advisor 仍不可用，要等下一轮——与用户预期不符。

**否定词窗口**：`NEGATION_WINDOW = 16` 字符，anchored 到窗口末尾。取 16 是因为最长的
否定式 `please do not ` 有 14 字符；太小会让 `do not use advisor` 漏判（实测踩过）。
anchored 测试保证窗口加宽不会误吞前一个从句里的否定词。

---

### 改动 F：lab 环境绝对禁止 advisor

**规则**：`~/.pi/agent/lab-mode.flag` 存在时，advisor **不可用**，且不参与任何 lab 工作。

**为什么是硬禁止而不是靠叮嘱**：advisor 每次调用把整条 context（≈130K tokens）发给外部模型。
lab 是逆向工作区，把工作内容外发正是 lab 模式要守住的边界，因此不能交给执行模型自行判断。

| 情形 | 行为 |
|---|---|
| lab 开启 + 说「调用 advisor」 | 拒绝 + 警告，不授权 |
| lab 开启 + 会话已有授权（先进 lab 再说关键词） | **暂停**：工具剥离，授权保留 |
| lab 开启 + 已有 `advisor` 工具 | reconcile 剥离（AND 在门里） |
| lab 开启 + 执行 `/advisor` 选模型 | 保存配置但拒绝授权 + 警告 |
| 退出 lab | **自动恢复**到进入 lab 前的状态 |
| 状态栏 | `advisor: off (lab mode)`（区别于「还没启用」） |

**实现**（`advisor/lab-mode.ts` + 4 处）：

- `lab-mode.ts` — `isLabModeActive()` 直接读磁盘标志文件，**每次调用都读，不缓存**
  （标志在进程内被聊天命令切换，加载时缓存会一直错）。
- `handlers.ts` — reconcile 里 `|| isLabModeActive()`（绝对禁令压过已有授权）；
  input hook 命中关键词时先查 lab 再决定授权，明确拒绝而非静默剥离。
  `before_agent_start` **不再写任何授权记录** —— 见下。
- `restore.ts` — lab 时提示「不参与 lab」而不是「说关键词即可启用」。
- `command.ts` — `applyEnable` 拒绝授权。

**标志文件路径必须与 `~/.pi/agent/extensions/security-audit-interceptor.ts`
的 `LAB_FLAG_PATH` 一致**，但**不要跨扩展 import**：两个扩展独立加载，跨扩展依赖会被
`/reload` 打断。代价是路径常量在两处重复，`check-upstream-merge.mjs` 断言了
`lab-mode.flag` 字面量作为提醒。

**暂停而非撤销（重要更正）**：本段最初实现为"进入 lab 就写 `{enabled:false}` 并清授权"，
这是错的。会话记录**优先于**配置默认值，一旦落盘为 false，`/advisor always on` 在退出 lab 后
**永远无法恢复** —— 与用户要求的"lab 禁令优先、退出后自动恢复"直接冲突。

现行实现：lab 只作为 reconcile 的阻断原因，**完全不碰授权**。因此：

- 进 lab → 工具剥离，授权保留
- 出 lab → 授权仍在，工具自动回来
- 只有用户显式 `/advisor off`、`/advisor always off` 才写 false 记录

`check-upstream-merge.mjs` 用 `forbiddenNeedle` 反向断言了这一点：`handlers.ts` 与
`restore.ts` 里**不得**出现 `recordSessionOptIn(pi, sessionId, false)`。

### 改动 G：`/advisor on` / `/advisor off`

**行为**：命令行的会话级开关，等价于说「调用 advisor」，但不需要开模型选择器。

| 命令 | 作用 |
|---|---|
| `/advisor on` | 授权当前会话并激活（需已有配置模型）；受 lab 禁令与执行器黑名单约束 |
| `/advisor off` | 只撤当前会话授权；**持久模型keep不变** |
| `/advisor`（无参） | 原行为：打开模型选择器，选中即授权 |
| `/advisor <其他>` | 报错并提示可用参数，不误开选择器 |

**为什么 `off` 不清模型**：`applyDisable`（选 No advisor）会同时清掉持久化的 `modelKey`。
`off` 的意图是「这次先别用」，不是「卸载配置」——清模型会让下次必须重选一遍。
两者语义不同，所以 `off` 走独立的 `applySessionOff`。

**`on` 的解析位置**：在 `ctx.hasUI` 交互守卫**之前**。on/off 只需要 `notify` 和
`setStatus`，非交互宿主也接受；放到守卫后面会在 `-p` 等场景直接报「需要交互模式」，
而这对一个纯状态开关毫无必要。

**补全**：`getArgumentCompletions` 提供 `on` / `off` / `always on` / `always off`，前缀过滤。

---

### 改动 H：授权跨 `/reload` 存活（appendEntry）

**问题**：`/reload` 会**替换整个扩展运行时**（Pi 文档原文：*Reload replaces the extension
runtime*，源码 `oldRunner.invalidate()` + `_buildRuntime`），于是 `session-optin.ts` 里的
`Set<string>` 被清空，授权必然丢失。而且 `/reload` 也会发 `session_start`，旧的
`restoreAdvisorState` 无条件 `resetSessionOptIn()`，等于再补一刀。

**结论**：纯内存方案不可能跨 reload 存活，必须写进 session 自己的账本。
（授权状态因此**不是**"纯内存"：内存 Set 是缓存，session 条目才是权威来源。）

**做法**：`pi.appendEntry("advisor-optin", { enabled })` 写；`session_start` 时用
`ctx.sessionManager.getBranch()` 倒序扫描 `customType === "advisor-optin"`，取**最后一条**重建。

**为什么用 `CustomEntry` 而不是 `CustomMessageEntry`**：Pi 文档明确
`CustomEntry` 「Does NOT participate in LLM context (ignored by buildSessionContext)」。
授权是控制面状态，绝不能进模型上下文；用 message 版会让每次开关注入一条用户消息。

**三个语义决定**：

1. **倒序取最后一条**。反复 on/off 之后必须收敛到**最新意图**，正序取第一条会永远停在历史值。
2. **无记录返回 `undefined` 而不是 `false`**。这样调用方才能区分「显式关过」和「从没表态」，
   后者才允许落到 `defaultEnabled` 默认值。
3. **fork 继承父会话的条目**。fork 是「复制这段对话」，连授权一起继承符合直觉；
   `/new` 没有条目，自然回到默认。

**写失败不降级**：`--no-session` 没有可写的会话，`appendEntry` 会抛错，此时仍保留内存授权
（`try/catch` 包住 append）。丢持久化不能顺带丢掉当前进程的授权。

---

### 改动 I：`/advisor always on|off`（跨会话默认）

**定位**：`always` 改的是「**没有自己记录的会话**从什么状态开始」，不是当前会话的开关。

| 命令 | 作用域 | 落盘位置 |
|---|---|---|
| `/advisor on` / `off` | 当前会话 | session 条目 |
| `/advisor always on` / `off` | 以后的会话 | `advisor.json` 的 `defaultEnabled` |

**优先级（从高到低）**：

```
lab mode 禁令  >  会话自己最后的记录  >  defaultEnabled  >  默认关闭
```

**为什么 lab 仍然最高优先级**：`always on` 只表示「默认想用」，不是「无条件使用」。
lab 是逆向工作区，advisor 会把整条上下文发给外部模型，这条边界不能被一个默认值覆盖。
实测：`defaultEnabled=true` + lab 开启 → 关闭；退出 lab → 自动恢复开启。

**为什么 `always` 与 `on/off` 分开写配置**：`saveAdvisorConfig` 会
`delete` 缺省字段，把 flag 塞进去会在无关的开关操作里连模型选择一起删掉。
因此新增独立的 `saveAdvisorDefaultEnabled()`。

---

**hook 顺序不敏感（实测两种顺序）**：

| 加载顺序 | `lab：调用 advisor` 单轮结果 |
|---|---|
| interceptor 先 | 标志先写入 → input hook 直接拒绝 |
| advisor 先 | input hook 先授权，但 interceptor 随后写标志，同轮的 `before_agent_start` 因 lab 在而剥离 → 仍是关闭 |

第二条依赖 reconcile 里的 lab 阻断，不依赖撤销 —— 授权此时仍然有效，只是工具被剥离。

---

---

## 五条不可动摇的设计约束

这些是踩过/被复核纠正过的。**升级重做补丁时逐条核对**，尤其 4 和 5：

1. **候选顺序必须是 `[配置的 primary, ...siblings]`。**
   绝不能按"健康度"重排。否则用户配的 advisor 会被静默换掉。
   代价：primary 耗尽时每次调用浪费一个被拒请求。这是**有界、可见、诚实**的代价。

2. **分类器要窄。** 见「改动 C」。

3. **抛出的异常也要过同一个分类器。** 抛出的 401/429 该换账号；抛出的网络超时/DNS/TLS/
   编程错误**不该**换——换账号修不了传输故障，且可能重发一个响应只是丢了的请求。

4. **★ 凭据/headers 绝不能提到循环外复用。** 复用 primary 的 headers 会让**每次尝试都用
   耗尽账号的凭据**，等于假装在换账号。这是最隐蔽的错误——代码看起来在工作，实际没换。

5. **★ 判定顺序必须是 aborted → error → 空响应。** 若空响应检查在前，无文本的配额错误会被
   当成空响应在**同账号**重试，可操作的错误信息被替换成通用的 "empty response"。

---

## 升级验收：`check-upstream-merge.mjs`

```bash
node ~/.pi/agent/local-plugins/rpiv-advisor-local/check-upstream-merge.mjs
# 退出 0 = 41 项关键点全部在位；1 = 有丢失，不要发布
```

它检查的不是数字，是**具体代码在不在**：上游 #295 的三处串联、四类 failover 约束、判定顺序、
分类器窄口径、人设三条款、opt-in 授权门、lab 禁令、on/off 子命令、授权持久化、always 默认。已用负向测试验证过它能查出：

| 故意注入的错误 | 是否捕获 |
|---|---|
| 删掉 `stripToolDeclarations` 调用 | ✓ FAIL |
| 凭据解析改成 `getApiKeyAndHeaders(advisor)` | ✓ FAIL |
| 把空响应判定插到 abort 之前 | ✓ FAIL |
| 分类器加入裸词 `/capacity/i` | ✓ FAIL |
| 人设被 `cp prompts/*` 覆盖回上游原版 | ✓ FAIL（4 项） |
| 删掉 reconcile 里的 opt-in 门 | ✓ FAIL |
| 删掉根 index 的 input hook 注册 | ✓ FAIL |
| 删掉 session_start 的授权重置 | ✓ FAIL |
| reconcile 去掉 `|| isLabModeActive()` | ✓ FAIL |
| reconcile 去掉 `isLabModeActive()` | ✓ FAIL |
| lab 分支重新写 false 记录（回归） | ✓ FAIL（forbiddenNeedle） |
| 删掉 session_start 的授权重建 | ✓ FAIL |

**上游发新版时，在 `UPSTREAM_INVARIANTS` 里追加一组该版本的断言**——旧组保留，
它们是回归防线而不是一次性检查。

---

## 验证

```bash
node ~/.pi/agent/local-plugins/rpiv-advisor-local/run-tests.mjs
```

测试脚本就在本插件根目录，自包含（会自己 stage 到临时 `work/`、用 esbuild 转译、
跑完即可删）。`work/` 是每次运行自动生成的一次性目录，不要提交、可随时删。

24 项行为测试，跑的是**真实 `execute.ts`** + stub 宿主上下文（断言"试了哪个候选、调用了几次、
信封内容"），不是重实现。其中 2 项覆盖上游 #295（`stripToolDeclarations`）。

覆盖的关键场景：
- 配额拒绝 → 转移到兄弟账号；凭据按候选重新解析
- 非可重试错误（503）→ **不**浪费兄弟账号
- 抛出的 429 转移 / 抛出的 `fetch failed` 不转移
- 无文本的 error 响应**不**被误判为空响应
- abort 立即停止、不启动新的计费请求；已 abort 的 signal 零调用
- 空响应在同账号重试一次；空两次是终态且**不**转移
- account-2 当主账号时保持队首并转移到 base
- 全账号耗尽时聚合所有尝试
- 链总调用数不超过 2×候选数（防止外层重试乘倍）
- **上游 #295**：`stripToolDeclarations` 剔除 `toolsAdded`/`toolsRemoved` 但保留正文与其它字段；无声明时**原样返回同一数组引用**（不走复制）

### 真实端到端验证（已完成）

用两个本地 HTTP 服务器（8791 = 主，8792 = 兄弟）+ 独立族名 `failovertest`（避开
`pi-multi-account` 预注册的幽灵 slot）实测：

| 主账号返回 | 结果 | 服务器日志 |
|---|---|---|
| **429** | 应答方 = `failovertest-account-2` ✅ 自动转移 | `PRIMARY 429` → `SIBLING 200` |
| **503** | 应答方 = `failovertest`，错误原样返回 ✅ 不浪费兄弟 | `PRIMARY 503`（SIBLING **零调用**） |

---

## 升级流程（上游发新版时）

> **操作手册已迁到 [`UPGRADING.md`](UPGRADING.md)。** 本节只保留设计层面的取舍说明，
> 避免两处流程描述逐渐不一致。

一句话版本：

```bash
node upgrade-check.mjs --from <解包后的上游目录> --expect-version <版本>
```

它在 `.upgrade-stage/` 里重建候选并验证，**不动当前插件**。补丁用 `-F0` 严格应用，
失败的 hunk 留下 `.rej` 供人工合并。

### 为什么不再"手工重做改动"

早期做法是照文档逐条重写 `execute.ts` 的 4 类改动。现在改动了 10 个上游文件（约 500 行），
手工重做必然出错且无法复核。改为冻结 `personal.patch`（9 个文件，已验证可从纯净上游
逐字节重建 fork），升级变成"打补丁 → 只处理冲突的 hunk"。

三种情况的工作量：

| 上游改了什么 | 结果 |
|---|---|
| 没碰你改过的 9 个文件 | `patch -F0` 全过，**零人工** |
| 在你改过的文件其他位置加东西 | 多数仍全过（行偏移可自动对齐） |
| 重构了你改过的同一批行 | 该文件出现 `.rej`，按 MANIFEST 的 A 类清单人工合并 |

### 为什么 `package.json` 不进补丁

补丁是字节级的，而 `package.json` 的版本号与依赖范围每个版本都会变，patch 必然冲突，
且冲突信息对"该怎么改"毫无指导价值。它改为按
`.upstream/package.overrides.json` 的**声明式规则重建**。

### 验收一：补丁完整性（必跑）

```bash
node ~/.pi/agent/local-plugins/rpiv-advisor-local/check-upstream-merge.mjs
```

检查 12 个具体代码点是否在位（上游 #295 的串联、四类 fork 约束、判定顺序、分类器窄口径）。
已用负向测试验证它能捕获：删 `stripToolDeclarations`、把 `(candidate)` 改回 `(advisor)`、
判定乱序、分类器加裸词。**这个脚本比 run-tests 更早拦截升级遗漏**，因为它不需要 esbuild。

### 验收二：行为测试

```bash
node ~/.pi/agent/local-plugins/rpiv-advisor-local/run-tests.mjs
# 24 项全过
```

❗ 跑测试前确认 esbuild 可用：`run-tests.mjs` 会去 `_npx` 缓存找
`@esbuild/win32-x64/esbuild.exe`，找不到就退回 PATH。两者都没有时报
`spawnSync esbuild ENOENT` —— 这**不是**代码错误，装一个即可：
`cd /tmp/esb && npm install esbuild`。

### 验收三：端到端（唯一能证明 failover 真在工作的）

```bash
pi -p --mode json --no-session --tools advisor \
   "Call the advisor tool exactly once. Then say DONE." \
  | python -c "import sys,json;[print(d['result']['details'].get('advisorModel')) for l in sys.stdin if (d:=json.loads(l)).get('type')=='tool_execution_end']"
```

判据：

| 现象 | 含义 |
|---|---|
| `advisorModel` = 配置的 primary | 正常，未转移 |
| `advisorModel` = 兄弟账号 | **failover 真的发生了**（primary 被拒） |
| `advisorModel` 缺失 | 升级坏了，details 契约破了 |

**注意**：`advisorModel` 是唯一观测点。如果失败转移后它仍报 primary，说明 `label` 改漏了。

另：`pi -p` 每次带 `--tools ""` 会把 advisor 也排除掉（空 allowlist），排查时别被这个坑误导。

### 升级时必须重新确认的上游改动点

| 关注点 | 原因 |
|---|---|
| `execute.ts` 的 `stopReasonEnvelope` / R6.4 空响应重试 | 本 fork 重排了判定顺序；上游若改了这段，需重新合并 |
| **`context.ts` 的消息改写链**（`stripInflightAdvisorCall` / `stripToolDeclarations`） | 本 fork 在 `execute.ts` 里调用了这两者；上游再加一层改写要同步接上 |
| `getApiKeyAndHeaders` 的返回形状 | 本 fork 按候选调用它；签名变了要改 |
| `ctx.modelRegistry.getAll()` | 候选来源；上游/宿主可能改 |
| `pi-ai` 的 `completeSimple` 入口（`/compat` vs 根） | `pi-compat.ts` 已做版本兼容，但大版本仍可能变 |
| `advisor.json` 的键 | `guidance` / `disabledForModels` 由本 fork 之外的配置层决定 |
| （历史教训）`stripToolDeclarations` 这类**新增导出** | 2.13.8 就是靠它修的 #295；升 2.13.x 时本 fork 的手工重做**最容易漏掉** |

---

## 依赖

- `@juicesharp/rpiv-config` ^2.13.8（实装，非 peer）
- **peer**：`typebox` `"*"` —— 由宿主提供，Pi 会把裸标识符别名到它捆绑的那份。
  **不要**再用 `npm install` 把它装回 `node_modules/`，也不要写回 `dependencies`。
- peer：`@earendil-works/pi-ai` / `pi-coding-agent` / `pi-tui` —— **由宿主提供，不要本地实装**

```bash
# 重装依赖（必须带 --legacy-peer-deps）
npm install --legacy-peer-deps
```

> ⚠️ **必须用 `--legacy-peer-deps`。** 否则 npm 会把 peer 依赖（`@earendil-works/pi-ai`、
> `typebox` 等）也装到本目录，插件就会用**自己那份 pi-ai / typebox** 而不是宿主那份。
> 前者版本偏移会出现难查的诡异故障，后者会产生**第二个 typebox 运行时实例**。
> 安装后应确认 `node_modules/@earendil-works` 与 `node_modules/typebox` **都不存在**。

---

## 目录结构说明

| 路径 | 作用 | 升级时是否动 |
|---|---|---|
| `advisor/execute.ts` | **唯一被手工重写的文件**（上游 + failover 补丁） | ★ 要重做 |
| `advisor/fallback.ts` | fork 独有：候选链 + 分类器 + 聚合 | 基本不动 |
| `prompts/advisor-system.txt` | ★ **已偏离上游**：加了防幻觉与权责边界条款 | ⚠️ 勿直接覆盖，见下 |
| 其余 `advisor/*.ts` `*.ts` `docs/` | 跟上游逐字节一致 | 直接覆盖 |

### ⚠️ `prompts/advisor-system.txt` 是本 fork 的第二个偏离点

2026-10-18 加了三条（相对 2.13.8）：

1. 停止信号门槛具体化：`halt the affected action for a decision only the user can make about scope, authorization, significant cost, or irreversible consequences`
2. 防幻觉段（整段新增）：`Do not invent unseen facts. ... never the filesystem. Never claim to have read a file, run a command, or observed test output that does not appear in the context above.`
3. 权责边界段（整段新增）：`The parent owns execution, verification, and user communication ...`

**为什么重要**：2.13.8 原版人设没有防幻觉条款，实测中 advisor 会编造行号
（「`target.ts:62-75`」但文件只有 12 行）、湿造实测（「Node v24 实测」「`target.test.mjs` 全部通过」
但该文件不存在）。加条款后同场景改为拒评并索要源码。

**升级时的正确做法**：

```bash
# 先用 diff 看上游这版有没有改人设
diff -u .upstream/prompts/advisor-system.txt.<旧版> <新版>/prompts/advisor-system.txt

# 若上游没改：保留本 fork 版（不要 cp 覆盖）
# 若上游改了：取上游新版，重加上述三段
```

推荐把上游每版的基准也存下来，路径固定为
`.upstream/prompts/advisor-system.txt.<版本>.orig`。
| `.upstream/execute.ts.<版本>.orig` | 上游基准源码（现 2.13.8），逐字节验证过 | 新增一份 |
| `.upstream/failover-<版本>.patch` | **补丁冻结件** —— 完整 8 hunk，可重放出当前 fork | 新增一份 |
| `check-upstream-merge.mjs` | ★ 升级验收：12 个代码点是否在位 | 新版加断言 |
| `test/fallback.test.mjs` + `run-tests.mjs` | 24 项行为测试 | 可能要补 |
| `work/` | 测试临时目录，可随时删 | — |

`~/.pi/agent/npm/node_modules/@juicesharp/rpiv-advisor` —— **原始 2.13.8**（未打补丁）。
它已从 `settings.json` 移除并**确实不再被加载**（已用探针验证 `sourceInfo.path` 指向本 fork）。
❗ **目录必须保留**：升级时要拿它跟 npm 新版做 diff。

> 早期用过的 `~/.pi/agent/rpiv-advisor-patch/` 脚手架**已删除**，其职能全部并入本插件目录。
