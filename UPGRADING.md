# 升级上游 — 机械流程

本文件给执行升级的 AI 看。人读的背景说明在 `PERSONAL_MAINTENANCE.md`。
文件分类清单在 `.upstream/MANIFEST.md`。

核心原则：**不要手工重做改动。** 改动已冻结成补丁，让 `patch` 去试；
只有它失败的那几个 hunk 才需要人判断。

---

## 0. 判断这次升级的规模

```bash
cd ~/.pi/agent/local-plugins/rpiv-advisor-local
cat .upstream/MANIFEST.md          # 哪些文件有本地改动
npm view @juicesharp/rpiv-advisor version   # 上游最新版
```

三种情况：

| 上游改了什么 | 预期结果 |
|---|---|
| 没碰你改过的 9 个文件 | `patch -F0` 全过，**零人工** |
| 在你改过的文件**其他位置**加东西 | `patch` 可能靠偏移自动对齐，多数仍全过 |
| 重构了你改过的**同一批行** | 该文件 hunk 失败，需按 MANIFEST 的 A 类清单人工合并 |

---

## 1. 取上游源码到暂存目录（**不要装进 npm 目录**）

npm 安装目录是基准来源之一，被覆盖后就无法回头比对。

```bash
mkdir -p /c/upstream-stage && cd /c/upstream-stage
npm pack @juicesharp/rpiv-advisor@<新版本号>
tar xzf juicesharp-rpiv-advisor-<新版本号>.tgz     # 得到 package/
```

---

## 2. 一条命令重建候选

```bash
cd ~/.pi/agent/local-plugins/rpiv-advisor-local
node upgrade-check.mjs --from /c/upstream-stage/package --expect-version <新版本号>
```

它做的事（全部在 `.upgrade-stage/`，**不触碰当前插件**）：

1. 复制上游源码到 stage
2. `patch -p1 -F0 --dry-run` 严格校验（**无 fuzz**）
3. 通过则真正应用 `.upstream/personal.patch`
4. 按 `.upstream/MANIFEST.json` 带入 fork 独有文件
5. 按 `.upstream/package.overrides.json` **重建** `package.json`
6. 在 stage 里跑 `check-upstream-merge.mjs` 与 `run-tests.mjs`

### 退出码

| 码 | 含义 | 下一步 |
|---|---|---|
| `0` | 候选通过 | 走第 5 步人工验收 |
| `1` | 断言或测试失败 | 看输出；stage 已保留 |
| `2` | 无法构建（补丁冲突/输入缺失/清单不一致） | 走第 3 步 |
| `3` | 环境缺失（缺 `patch` 等） | 装工具，不要绕过 |

---

## 3. 补丁失败怎么处理（唯一需要动脑的地方）

失败时 stage 会保留，并留下 `.rej` 文件：

```
.upgrade-stage/<版本>-<时间戳>/
  advisor/execute.ts
  advisor/execute.ts.rej      ← 没能应用的 hunk
```

处理顺序：

1. **只打开 `.rej` 对应的那一个文件**，按 `.upstream/MANIFEST.md` 的 A 类表格确认
   这个文件承担了什么功能（例如 `execute.ts` = failover）。
2. 把 `.rej` 里的改动**按语义**重新写进新文件，不要照抄行号。
3. 删掉 `.rej`，然后复验：

```bash
node upgrade-check.mjs --stage .upgrade-stage/<版本>-<时间戳>
```

4. 全过后，**重新冻结补丁**（否则下次升级仍会撞同一处）：

```bash
# 用新版上游作基准
cp -r /c/upstream-stage/package .upstream/baseline-<新版本号>
rm -rf .upstream/baseline-<新版本号>/node_modules
# 重新生成 personal.patch（9 个文件，见 MANIFEST 的 A 类）
# 更新 MANIFEST.json / MANIFEST.md 的版本与哈希
```

> 旧的 `.upstream/baseline/` **不要删**。它是上一个版本的比对点，
> 也是"这次升级到底改了什么"的证据来源。

---

## 4. `package.json` 的规则（不要复制旧文件）

`.upstream/package.overrides.json` 是声明式规则，`upgrade-check.mjs` 会自动套用：

- `name` → `rpiv-advisor-local`，`private: true`
- `version` → `<上游版本>-personal`
- 移除 `author` / `repository` / `homepage` / `bugs` / `publishConfig` / `scripts` / `files`
- `typebox` 必须在 `peerDependencies: "*"`
- 宿主包（pi-ai / pi-coding-agent / pi-tui / typebox）**不得**出现在 `dependencies`
- 其余字段（`peerDependencies`、`pi` 块等）**一律取新版**

`package-lock.json` 由 `npm install --legacy-peer-deps` 重新生成，**绝不手工合并**。

---

## 5. 人工验收（脚本替代不了）

候选通过后，**不要直接覆盖当前插件**。先把 stage 临时指向它做真实运行检查：

```bash
# 以 stage 作为扩展启动一次真实会话
pi -p --mode text --no-session \
  -e .upgrade-stage/<版本>-<时间戳>/index.ts \
  "说 OK"
```

确认点：

1. 扩展能加载，无 `peerDependencies` 之外的新警告
2. `/advisor on` 能启用，`/advisor off` 能关闭
3. 默认关闭：新会话里 `advisor` 不在工具清单
4. lab 标志存在时不可用；删掉标志后自动恢复
5. （**可选，默认跳过**）真实调用一次 advisor 确认 `details.advisorModel` 有值

第 5 项 ≈ 13 万 token，且会把会话上下文外发。**升级流程不包含这一步**；
failover 链路由 `test/fallback.test.mjs` 的桩主机测试覆盖。只有用户明确要求时才跑。

---

## 6. 切换到候选

确认无误后：

```bash
# 备份
cp -r . ../rpiv-advisor-local.bak-$(date +%Y%m%d-%H%M%S)

# 用 stage 覆盖（保留 .upstream、AGENTS.md 等本地资产）
# 建议逐个目录确认，而不是一把 rsync --delete
```

然后在本目录再跑一次验收，确认运行的是正式位置：

```bash
node check-upstream-merge.mjs && node run-tests.mjs
```

`/reload` 使 Pi 重新加载扩展。

---

## 7. 常见失败模式

| 现象 | 原因 | 处理 |
|---|---|---|
| `Hunk #N FAILED` | 上游改了你改过的行 | 第 3 步人工合并 |
| `✗ fork 独有文件缺失` | 清单与磁盘不一致 | 查 `.upstream/MANIFEST.json` 的 `fork_only` |
| `✗ 补丁与上游冲突` 但 `.rej` 是空的 | 上游删了补丁依赖的整段 | 看 `personal.patch` 该文件的 hunk 头 |
| `EEXIST ... symlink` | 上次崩溃留下的 `work/` | 已由 `removeTree()` 处理；若仍出现手工删 `work/` |
| 行为测试 `exit 1` 但断言全过 | 逻辑被改坏 | **以行为测试为准**，静态断言只查"在不在" |
| `Cannot resolve ... index.ts` | 未装依赖 | `npm install --legacy-peer-deps` |

---

## 8. 给 AI 的直接指令（可整段复制给我）

```
在当前目录（~/.pi/agent/local-plugins/rpiv-advisor-local）执行上游升级：
1. 先读 AGENTS.md、UPGRADING.md、.upstream/MANIFEST.md
2. 用 npm pack 把上游新版解包到 /c/upstream-stage/package，不要装进 npm 目录
3. 跑 node upgrade-check.mjs --from /c/upstream-stage/package --expect-version <版本>
4. 若有补丁冲突：只按 .rej 逐个 hunk 语义合并，不要推倒重写整个文件；
   合并后重新生成 personal.patch 并更新 MANIFEST
5. 验收：check-upstream-merge.mjs + run-tests.mjs 必须退出 0
6. 报告：改了什么、哪些 hunk 需要人工、验证结果、仍未覆盖的风险
不要提交 git，不要覆盖当前插件，除非我明确要求。
```
