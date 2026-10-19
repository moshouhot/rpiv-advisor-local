# rpiv-advisor-local — AI 工作须知

这是 `@juicesharp/rpiv-advisor` 的**本地 fork**，不是上游原版。
目录：`~/.pi/agent/local-plugins/rpiv-advisor-local/`

**动手前先读完本文件。升级时还必须读 `UPGRADING.md`（机械流程）与
`.upstream/MANIFEST.md`（文件分类清单）。**

---

## 一、三条不可商量的行为

1. **advisor 默认关闭。** 每个会话初始不可用，只有用户在该会话明确说「调用 advisor」
   或执行 `/advisor on` 才启用。不要"顺手"改回默认开启。
2. **lab 环境绝对禁用 advisor。** `~/.pi/agent/lab-mode.flag` 存在时一律不可用。
   lab 只**暂停**、不吊销授权；退出 lab 后自动恢复。
3. **failover 的判定顺序是 aborted → error → 空响应。** 顺序错了会把配额错误
   误判成空响应，在不换账号的情况下重试。

---

## 二、修改前必须知道的事

### 不要用上游文件覆盖这些（会静默丢功能）

| 文件 | 丢了什么 |
|---|---|
| `advisor/execute.ts` | 跨账号 failover |
| `advisor/handlers.ts` | opt-in 授权门、input hook |
| `advisor/restore.ts` | session_start 重建授权 |
| `advisor/command.ts` | `/advisor on\|off\|always` |
| `advisor/messages.ts` | 上述功能的文案 |
| `advisor/index.ts`、`index.ts` | 导出与 hook 注册顺序 |
| `advisor/config.ts` | `defaultEnabled` |
| `prompts/advisor-system.txt` | 防幻觉 / 权责边界 / 停止信号门槛 |

**`cp` 上游文件之前先想清楚：这些文件里有本地改动。**

### `settings.json` 里的本地包条目必须是纯字符串

```jsonc
"packages": ["./local-plugins/rpiv-advisor-local"]   // 正确
```

对象形式 `{ "source": "...", "extensions": [] }` 中的空数组是**匹配不到任何东西的过滤器**，
会**静默禁用整个包**。本 fork 曾因此长期未生效。

### 两种已知的 Windows 非 ASCII 路径故障

本仓库的脚本已绕开，但**不要把它们改回去**：

- `fs.cpSync` 在路径含中文时**直接崩溃**（exit `0xC0000409`，无输出无异常）。
  已用 `copyTree()`（`readdirSync` + `copyFileSync`）替代。
- `fs.rmSync(recursive)` 在同样条件下**静默失败**（返回成功但没删）。
  已用 `removeTree()`（`lstatSync` + `unlinkSync`）替代。
- `esbuild` 无法解析非 ASCII 路径 → 所有转译在 `os.tmpdir()` 下的 ASCII 目录进行。

---

## 三、改完必须验证（缺一不可）

```bash
cd ~/.pi/agent/local-plugins/rpiv-advisor-local

node check-upstream-merge.mjs    # 43 项静态断言：关键代码点是否还在
node run-tests.mjs               # 行为测试：24 项 failover + 31 项 opt-in/lab
```

**退出码非 0 时不得声称已完成。** 静态断言通过 ≠ 功能正确 —— 实测过
「断言全过、行为测试失败」的组合，两层验证各有各的盲区。

改动涉及配置或提示词时，再加格式门禁：

```bash
python "$env:USERPROFILE/.pi/agent/skills/windows-file-format/scripts/audit_format.py" \
  <改动的 .json/.md/.txt 文件> --policy "$env:USERPROFILE/.pi/agent/format-policy.json"
```

`.ts` / `.mjs` 不在该技能支持范围内，用 `node --check` 代替，并如实说明未覆盖。

---

## 四、升级上游时

**只走 `UPGRADING.md`。** 一句话概括：

```bash
node upgrade-check.mjs --from <解包后的上游目录> --expect-version <版本>
```

它会在 `.upgrade-stage/` 里重建候选并验证，**不动当前插件**。
退出码：`0` 通过 / `1` 检查失败 / `2` 无法构建（补丁冲突等）/ `3` 环境缺失。

补丁冲突是**人工合并**的信号，不是可以跳过的情况。stage 会保留含 `.rej` 的诊断。

---

## 五、不要做的事

### 不要为"验证"而真实调用 advisor（硬约束）

真实调用一次 advisor ≈ **13 万 token**，且会把整条会话上下文外发给外部模型。

- **默认不跑。** 断言 + `run-tests.mjs` 已用桩主机覆盖 failover、授权门、lab 禁令，
  零 token 成本。这两层退出码为 0 即可认为逻辑正确。
- **只在用户明确要求时跑**，例如用户说"确认一下真的能连上"。
  升级流程本身**不包含**这一步。
- 想确认扩展能加载，用最小会话，不要带 advisor 任务：

  ```bash
  pi -p --mode text --no-session -e ./index.ts "说 OK"
  ```

  单轮、默认关闭、advisor 工具不注入，成本可忽略。
- 报告里不得把"桩测试通过"说成"真实链路已验证"。

### 其他

- 不要用 `--tools ""` 测试 advisor：空 allowlist 会排除所有工具，包括 advisor 本身。
- 不要把这个 fork 的改动当成「上游该有的样子」去提 PR —— 默认关闭、lab 禁区、
  双账号 failover 都是本地策略，上游的定位不同。
- 不要在没有实际运行的情况下声称某项验证通过。advisor 自己也看不到磁盘，
  它声称的测试结果必须由你实际跑过才算数。
