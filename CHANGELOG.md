# Changelog

## Unreleased

### Added

- `applyTransformsUntilFixedPoint`（`packages/webcrack/src/ast-utils/transform.ts`）：
  通用不动点循环。重复执行一组 transform，直到一整趟没有任何改动
  （`converged: true`）或达到 `maxIterations`（默认 10，返回
  `converged: false` 并输出带趟数/改动数的 debug 日志）。返回
  `FixedPointState { changes, iterations, converged }`。
- deobfuscate 的清理 transforms（`mergeStrings`、`deadCode`、
  `controlFlowObject`、`controlFlowSwitch`）从单趟改为不动点循环
  （`packages/webcrack/src/deobfuscate/index.ts`）。它们互相使能（死分支删除
  露出新的字符串拼接、控制流还原产生新的死分支），循环保证跑到真正的不动点。
- `createNodeSandbox({ timeout })` 选项，超时从硬编码 10s 变为可配置，便于
  测试超时保护路径。
- 测试：`ast-utils/test/transform.test.ts`（不动点循环语义）、
  `deobfuscate/test/fixed-point.test.ts`（排程/沙箱 I/O 追踪与幂等）、
  `deobfuscate/test/vm.test.ts`（沙箱隔离、超时、错误传播、失败恢复）。
- `ANALYSIS.md`：入口、状态、缓存、错误传播与输出的完整追踪分析。

### Fixed

- `createNodeSandbox` 在 eval 抛错（含超时）时现在通过 try/finally 保证
  `context.release()` 与 `isolate.dispose()` 执行，失败路径不再泄漏 isolate。

### 实现选择

- 收敛判定用「一整趟 0 改动」而非「改动数不再增长」：前者是严格的不动点，
  直接蕴含幂等（再跑一遍第一趟即 0 改动）。
- 达到迭代上限不抛异常：deobfuscate 是尽力而为的管线，对对抗性输入应降级为
  部分结果 + 可诊断日志，而不是让整个解混淆失败。
- 循环只包四个纯 AST→AST 的清理 transform；decoder 内联（需要沙箱往返）留在
  循环外，避免重复执行外部代码。

### 原覆盖的空白

- 此前没有任何测试断言清理 transforms 的终止性：单趟 `applyTransforms` 既无法
  证明收敛，也对互相使能的 transform 链可能欠跑一趟。
- 沙箱完全无测试：宿主能力阻断、超时、错误降级（`ERR_MODULE_NOT_FOUND`、
  原生模块不匹配）与失败恢复路径均无覆盖。
- deobfuscate 整体无幂等性验证，沙箱输入输出（批量求值、rotator 在沙箱内
  执行）无任何观测点。

### 相邻语义的退化保护

- 全部 289 个既有测试（含 20 个 obfuscator.io 样例快照）在接入不动点循环后
  无一变化，证明循环对既有样例是行为保持的。
- `webcrack()` 公共入口与直接 `applyTransformAsync(ast, deobfuscate, sandbox)`
  两个对称入口对同一样例产出逐字节一致的结果。
- 幂等用例锁定：deobfuscate 第二趟 `changes === 0`、输出不变、沙箱不再被调用。

### 最危险反例与回归用例

- **AST 不动点**：两个互相撤销的 transform（`'a'→'b'`、`'b'→'a'`）每趟都上报
  改动但净效果恒等，改动计数永不收敛，无上限时 deobfuscate 死循环。回归用例：
  `transform.test.ts` 的「stops at maxIterations when two transforms undo each
  other」（5 趟后 `converged: false`，AST 保持恒等）。
- **执行沙箱**：decoder/rotator 中的 `while (true) {}` 会让求值永不返回。
  回归用例：`vm.test.ts` 的「terminates infinite loops via the timeout」。
- **JavaScript 去混淆**：解码结果不是字符串（越界下标返回 `undefined`）时
  不能崩溃，只能附加 `webcrack:decode_error` 注释继续——由既有样例
  `obfuscator.io.js` 的快照锁定。
