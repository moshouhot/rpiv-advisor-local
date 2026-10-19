# rpiv-advisor-local — 备份仓库

`@juicesharp/rpiv-advisor` 本地 fork 的**离线副本与历史**。
运行位置在 `~/.pi/agent/local-plugins/rpiv-advisor-local/`。

---

## 为什么要有一份放在这

`~/.pi/agent/local-plugins/` 是 Pi 的事务目录。插件的安装、更新、清理都可能整体
替换或删除里面的内容，而且它**不在任何版本控制之下**。这个 fork 里 500 多行本地改动
（failover、会话授权门、lab 禁令）没有任何上游来源可以找回。

本目录放在 Nextcloud 同步盘里，同时提供两件事：

1. **离线副本** —— 运行位置被清掉时能整套还原
2. **历史** —— 每次升级或修 bug 都有一个可回溯的提交点

---

## 哪一份是权威

**运行位置是权威，本目录是它的镜像。**

Pi 通过 `~/.pi/agent/settings.json` 里的 `"./local-plugins/rpiv-advisor-local"`
加载插件，**不会**读这个目录。改代码要改运行位置，否则改动不生效。

验证两边是否一致：

```bash
cd "/f/Nextcloud/project/PI插件/rpiv-advisor-local"
git status --short          # 空 = 与上次提交一致
```

---

## 日常流程

### 改完代码，同步过来

```bash
SRC=~/.pi/agent/local-plugins/rpiv-advisor-local
DST="/f/Nextcloud/project/PI插件/rpiv-advisor-local"

# 1. 先在运行位置验证（这步不能跳）
cd "$SRC" && node check-upstream-merge.mjs && node run-tests.mjs

# 2. 同步源文件（排除依赖与构建产物）
tar --exclude=node_modules --exclude=work --exclude=.upgrade-stage \
    -cf - . 2>/dev/null | (cd "$DST" && tar xf -)

# 3. 提交
cd "$DST" && git add -A && git status --short && git commit -m "<说明>"
```

### 运行位置出问题，从本目录还原

```bash
SRC=~/.pi/agent/local-plugins/rpiv-advisor-local
DST="/f/Nextcloud/project/PI插件/rpiv-advisor-local"

cd "$DST" && tar --exclude=.git --exclude=.gitignore --exclude=.gitattributes \
    -cf - . 2>/dev/null | (cd "$SRC" && tar xf -)

# 还原后必须重新装依赖（node_modules 不在仓库里）
cd "$SRC" && npm install --legacy-peer-deps
cd "$SRC" && node check-upstream-merge.mjs && node run-tests.mjs
```

`node_modules` 刻意不入库：它只有 41K，一条 `npm install` 就能重建，锁文件
`package-lock.json` 已经保证版本一致。

---

## 换行符：不要改 `.gitattributes`

仓库内统一存 LF、检出也不转换（`* text=auto eol=lf`）。这不是风格偏好：

- `.upstream/personal.patch` 必须**字节级**可重放（`patch -p1 -F0`），
  任何一个 hunk 的行尾变成 CRLF 都会失配
- `.upstream/MANIFEST.json` 记录的是 sha256，换行一变哈希全变

`core.autocrlf` 在本仓库内已被固定为 `false`。如果 clone 到新机器，先确认：

```bash
git config --get core.autocrlf    # 应为 false
git ls-files --eol | grep -v "i/lf" | head   # 应无输出
```

唯一例外是 `package-lock.json`，它由 npm 生成，不要手工改换行。

---

## 目录说明

| 路径 | 内容 |
|---|---|
| `advisor/` | fork 源码。`fallback.ts`、`session-optin.ts`、`lab-mode.ts` 是 fork 独有 |
| `.upstream/baseline/` | 上游 2.13.8 完整快照（23 文件），所有 diff 的基准 |
| `.upstream/personal.patch` | **权威重建资产**：9 文件 / 952 行，`-F0` 逐字节重建本 fork |
| `.upstream/MANIFEST.md` `.json` | 文件分类与全部 sha256 |
| `.upstream/UPSTREAM.txt` | 升级资产的入口索引 |
| `AGENTS.md` | AI 工作硬约束（不复制上游覆盖、不为验证真实调用 advisor 等） |
| `UPGRADING.md` | 升级操作手册 |
| `upgrade-check.mjs` | 一键暂存候选并验证，退出码 0/1/2/3 |
| `PERSONAL_MAINTENANCE.md` | 设计理由与改动规格（背景资料） |

---

## 当前状态

版本 `2.13.8-personal`，基于上游 2.13.8。

验证基线：43 项静态断言 + 55 项行为测试（24 failover + 31 授权门/lab），
外加同版本重建逐字节一致。

详细维护说明见 `PERSONAL_MAINTENANCE.md`；升级上游见 `UPGRADING.md`。
