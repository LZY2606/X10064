# Changelog

## Unreleased — 不动点变换循环、副作用沙箱与终止判定

本次变更为**纯分析与测试**，未改动任何 `src/` 运行时代码：现有实现已满足
收敛与隔离要求，缺的是把不变量固化下来的可执行反证与文档。

### Added

- `ANALYSIS.md`：串起入口（`webcrack()` stage 数组与
  `applyTransformAsync` transform 级对称入口）、状态
  （`TransformState.changes` 污染标记）、缓存（检测重命名 +
  `VMDecoder.setupCode` 单次生成 + 批量解码单次沙箱往返）、错误传播
  （`VMDecoder.decode` 的三类错误分派）与输出（`generate` +
  `webcrack:decode_error` 注释）；论证循环收敛（变换均为良基度量上的
  缩减、使能关系无环）并列出"哪些节点改动让之前失败的 transform 变得
  可用"。
- `packages/webcrack/src/deobfuscate/test/fixed-point.test.ts`：8 个
  追踪/反证测试，样例同时包含数组 rotator（预旋转一位，强制 rotator
  真实执行）、别名 decoder（`m`/`n` 别名链）、常量折叠实参
  （`m(0x100 + 0x2)`）与死分支（`if ('abc' === 'def')`）。

### 实现选择

- 追踪通过包装公共 `Sandbox` 选项记录输入输出，而非 monkey-patch 内部
  模块——测试只依赖公开契约，重构内部实现不会误伤。
- 幂等性在两个对称入口分别证明：完整管线
  `webcrack(webcrack(sample).code)` 逐字节相等；transform 级第二遍
  `changes === 0` 且输出不变（污染标记归零）。
- 最大迭代保护用**真实** `createNodeSandbox()` 验证（10s isolate
  timeout），不用假时钟或随机 sleep；该用例是整个套件中唯一慢用例，
  换取对"宿主不会被攻击者控制的 rotator 拖死"的直接证明。
- 不用真实外网、不用本机绝对路径、不按 fixture 名称特判；样例全部
  内联构造。

### 原覆盖的空白

既有 `samples.test.ts` 只有端到端快照，以下不变量此前完全没有断言：

- 沙箱调用次数与批量解码（13 个调用 = 1 次沙箱往返）；
- 重跑幂等与 `changes` 计数归零（不动点判定）；
- 无字符串表时 deobfuscate 是 no-op（边界一侧）；
- 无 rotator 时解码仍成立（边界另一侧）；
- 永不终止的 rotator 被沙箱超时杀死而非挂起宿主（失败恢复）；
- isolate 内无 `process` 等宿主能力（副作用沙箱隔离）；
- 自定义沙箱的拒绝逐字传播（错误上下文不丢失）。

### 相邻语义的退化保护

- 全套 `corepack pnpm test` 保持绿色（51 文件 / 289 通过），未触碰任何
  既有快照。
- 软失败语义锁定：越界下标 `m(0x999)` 产出
  `/*webcrack:decode_error*/undefined`，同批次其余调用照常解码——防止
  "一个坏调用毒化整批"或"静默吞错"两类退化。
- 条件调用拆分（`decode(flag ? a : b)` → `flag ? decode(a) : decode(b)`）
  与别名链内联各有断言，防止 `collectCalls` 匹配器收紧时静默漏解码。

### 最危险反例与对应回归用例

JavaScript 去混淆 / AST 不动点 / 执行沙箱三者交叉处最危险的反例是
**永不终止的 rotator**：javascript-obfuscator 的 rotator 是
`while (!![])` 死循环，靠校验和命中退出，而 webcrack 会把这段
**攻击者完全控制**的代码拿来自己执行。若校验和被构造为永不满足
（样例中 333 → 334），没有 `timeout: 10_000` 的进程会永久挂起
（远程 DoS）；若沙箱泄露宿主能力，rotator 前置语句里的
`process.exit(1)` 会直接杀死宿主。对应回归用例：

- `max-iteration protection: non-halting rotator is killed by the
  sandbox timeout` —— 断言管线以 `Script execution timed out` 拒绝；
- `sandbox isolate exposes no host capabilities` —— 断言逃逸载荷以
  `process is not defined` 失败而非生效。
