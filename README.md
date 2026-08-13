# dsh-sleep

DSH 插件：向模型暴露一个 `sleep` 工具，让模型按指定毫秒数暂停执行后再返回。适合等待时间相关条件成立（服务重启、debounce 窗口、retry backoff）且没有事件型工具可用的场景。

## 安装

```sh
# 从 git 安装（推荐）：
dsh plugin --profile <profile> add github:huanlinoto/dsh-plugin-sleep

# 从本地 checkout 开发安装：
dsh plugin --profile <profile> add link:D:\Projects\deepseek-harness\dsh-sleep
```

预构建策略：`lib/` 入库，无 `prepare` 脚本，`github:` 安装开箱即用，无需 `allowBuilds`。

## 配置

在 DSH GUI 设置页或 `cordis.patch.yml` 中配置：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `maxDurationMs` | number | `60000` | 单次 sleep 上限毫秒数。超过会被 clamp 到此值，并在返回中标 `clamped: true`。 |
| `defaultDurationMs` | number | `0` | 当模型省略 `duration_ms` 时的回退值。 |

## 工具

### `sleep`

暂停 N 毫秒后返回。

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `duration_ms` | integer | 是 | 暂停毫秒数，必须 ≥ 0。超过 `maxDurationMs` 会被 clamp。 |
| `reason` | string | 否 | 人类可读的暂停理由，会原样回显。 |

**返回（规范 JSON）：**

```jsonc
{
  "requested_ms": 1000,   // 调用方原始请求值
  "actual_ms": 1002,      // 实际等待毫秒数
  "cancelled": false,     // 是否被 abort 信号中断
  "clamped": false,       // 是否因超过 maxDurationMs 被钳制
  "reason": "..."         // 可选回显
}
```

取消语义：如果 sleep 中途 `exec.signal` 被 abort，工具**不抛错**，而是立即返回 `cancelled: true`（取消属于业务非理想态，不属基础设施失败，参见 `plugin-development-guide.md` §3 C5）。

## 开发

```sh
pnpm install          # 安装开发依赖（schemastery、typescript、vitest）
pnpm run typecheck    # tsc --noEmit 类型检查
pnpm test             # vitest run 单元测试
pnpm run build        # tsc + tsdown → lib/
```

## 检查

合规自检（参见 `plugin-development-guide.md` §10）：

- [x] **零源码 patch**：未修改 DSH checkout 任何文件
- [x] B1: `package.json` 声明 `dsh.bundle.patch`
- [x] B2: 插件自带 `cordis.patch.yml`（insert 行 id/name/config 齐全）
- [x] B3: patch 行 `name` 用包名（Loader 从 profile node_modules 解析）
- [x] F1: `files` 含 `lib/` + `cordis.patch.yml`
- [x] F2: `peerDependencies` 含 cordis + `@deepseek-ai/dsh-tools`（不用 devDependencies 冒充）
- [x] F3: typecheck/test/build script 齐全
- [x] A4: Config 用 Schemastery schema
- [x] A6: 不导出 default
- [x] C4: 工具返回规范 JSON 值 + render 投影分离
- [x] C6: 尊重 `exec.signal` 取消在途工作
- [x] G: Unit 测试（`tests/tools.spec.ts`，35+ 用例）

## 目录结构

```
dsh-sleep/
├── src/
│   ├── index.ts        # 入口：name、inject、Config（Schemastery）、apply
│   ├── tools.ts        # sleep 工具定义 + 可取消等待逻辑 + render 投影
│   └── types.d.ts      # @deepseek-ai/dsh-tools + cordis 的环境类型声明
├── tests/
│   └── tools.spec.ts   # 单元测试（覆盖正常/取消/clamp/边界）
├── cordis.patch.yml    # bundle 层：插入 dsh-sleep 插件行
├── package.json        # dsh.bundle.patch 声明 + peerDeps
├── tsconfig.json       # NodeNext、ES2022、strict
├── tsdown.config.ts    # 单 entry（host-only，无 client bundle）
└── vitest.config.ts    # vitest forks pool
```
