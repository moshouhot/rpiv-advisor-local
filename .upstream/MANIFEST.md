# 上游基准与 fork 偏离清单

> 本文件是**机器可读清单的唯一权威说明**。升级前先读它，不要凭记忆判断哪些文件被改过。
> 配套：`baseline/`（冻结的上游源码）、`personal.patch`（本 fork 的全部源码偏离）。

## 冻结基准

| 项 | 值 |
|---|---|
| 包名 | `@juicesharp/rpiv-advisor` |
| 版本 | **2.13.8** |
| 基准目录 | `.upstream/baseline/`（23 个文件，排除 `node_modules`） |
| 基准来源 | 从已安装的 npm 包整体复制，非手工重打 |

`baseline/` 是**冻结快照**，不是"当前安装版本"。升级到新版本时**生成新的 baseline 目录**
（如 `baseline-2.14.0/`），旧目录保留 —— 它们是历史比对点，不是可覆盖的临时文件。

## 四类文件（升级时的处理方式完全不同）

### A. 上游已改 —— 必须用 patch 重放，禁止 `cp` 覆盖

| 文件 | 本 fork 改了什么 |
|---|---|
| `advisor/command.ts` | `/advisor on\|off\|always on\|always off` 子命令 |
| `advisor/config.ts` | `defaultEnabled` 字段 + `saveAdvisorDefaultEnabled()` |
| `advisor/execute.ts` | 跨账号 failover（候选链、逐候选凭据、判定顺序） |
| `advisor/handlers.ts` | opt-in 授权门 + `input` hook + 撤销/状态栏 |
| `advisor/index.ts` | 导出 opt-in / lab-mode / 持久化符号 |
| `advisor/messages.ts` | opt-in、lab、always 的文案 |
| `advisor/restore.ts` | session_start 重建授权 + 恢复顺序 |
| `index.ts` | 注册 `registerInputOptInHandler`（须在 before_agent_start 之前） |
| `prompts/advisor-system.txt` | 防幻觉 / 权责边界 / 停止信号门槛 |

全部 9 个文件的改动冻结在 **`personal.patch`**。

### B. fork 独有 —— `cp` 不会删，但也**不会自动出现**

升级到全新目录重建时必须**手工带上**：

| 文件 | 作用 |
|---|---|
| `advisor/fallback.ts` | 候选链、窄分类器、失败聚合 |
| `advisor/session-optin.ts` | 按会话授权 + `appendEntry` 持久化 |
| `advisor/lab-mode.ts` | 读取 `lab-mode.flag` |
| `test/fallback.test.mjs` | failover 行为测试（24 项） |
| `test/session-optin.test.mjs` | opt-in / lab / 持久化测试（31 项） |
| `run-tests.mjs` | 测试装配器（转译 + 路径重写） |
| `check-upstream-merge.mjs` | 41 项静态断言 |
| `PERSONAL_MAINTENANCE.md` | 改动规格与设计理由（背景资料） |
| `AGENTS.md` | AI 工作须知（Pi 在插件目录下自动读入） |
| `UPGRADING.md` | 升级操作手册（机械流程） |
| `upgrade-check.mjs` | 暂存候选并验证，不动当前插件 |
| `package-lock.json` | 依赖锁定（见 D） |

### C. 上游未改 —— 可以直接覆盖

`LICENSE`、`README.md`、`advisor-ui.ts`、`advisor/context.ts`、`advisor/inventory.ts`、
`advisor/pi-compat.ts`、`advisor/policy.ts`、`advisor/prompt.ts`、`advisor/register.ts`、
`advisor/state.ts`、`docs/configuration.md`、`docs/tool-reference.md`、`fuzzy.ts`

> 它们现在没改，**不代表升级时可以不管**。上游可能在这些文件里新增本 fork 依赖的行为
> （历史教训：#295 的 `stripToolDeclarations` 就加在 `context.ts` 里）。升级后仍要跑断言。

### D. 依赖元数据 —— **禁止用旧文件覆盖新版**

| 文件 | 规则 |
|---|---|
| `package.json` | 只允许三处人工改动：①`version` 改为 `<上游版本>-personal`；②`typebox` 必须在 `peerDependencies: "*"`（上游 2.12.0 起）；③不得新增 `dependencies` 里的宿主包。其余字段一律取新版。 |
| `package-lock.json` | 由 `npm install --legacy-peer-deps` 重新生成，**绝不手工合并或从旧版复制**。 |

`package.json` 已偏离上游，但**故意不放进 `personal.patch`**：补丁是字节级的，
而该文件的版本号与依赖范围每个版本都会变，patch 必然冲突且失败信息没有指导价值。
它改为"按规则重建"，由 `UPGRADING.md` 的第 4 步人工确认。

## 已知的偏离计数（用于快速自查）

```
A 上游已改      10 个（9 个进 patch + package.json 按规则）
B fork 独有      12 个
C 上游未改      13 个
D 上游有 fork 缺  0 个
```

升级后如果 A/B/C 的数量或名单变化，说明有未记录的改动 —— 先查清再继续。

机器可读的版本（含每个文件的 sha256）在 `MANIFEST.json`。注意
**`upgrade-check.mjs` 从磁盘推导 B 类清单**，不依赖本文件：

- 磁盘有、清单无 → 仅告警（清单该更新了）
- 清单有、磁盘无 → **exit 2 硬错误**（fork 资产丢了，必须恢复）
