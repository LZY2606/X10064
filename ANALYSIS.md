# webcrack：不动点变换循环、副作用沙箱与终止判定

本文档追踪 webcrack 的 deobfuscate 管线：多个 transform 如何被排程、如何通过
`changes` 污染标记驱动重跑、decoder/rotator 如何在受限沙箱中执行，以及循环为何
终止。所有结论都有对应的可执行测试（见文末「可执行反证」）。

## 入口与排程

两个对称入口，行为一致（`fixed-point.test.ts` 同时验证两者）：

- 公共 API：`webcrack(code, options)`（`packages/webcrack/src/index.ts`），
  依次执行 parse → prepare → **deobfuscate** → unminify → selfDefending /
  debugProtection → mergeObjectAssignments / evaluateGlobals → generate → unpack。
- 直接调用：`applyTransformAsync(ast, deobfuscate, sandbox)`
  （`packages/webcrack/src/deobfuscate/index.ts`）。

deobfuscate 内部的排程顺序（每步都向同一个 `state.changes` 累加污染标记）：

1. `findStringArray`：定位字符串表，重命名为 `__STRING_ARRAY__`；找不到则提前返回。
2. `findArrayRotator`：定位旋转 IIFE（`while(!![])` + `parseInt` + try/catch
   `push(shift())` 结构），可选。
3. `findDecoders`：定位 decoder 函数，重命名为 `__DECODE_0__`…。
4. `inlineObjectProps`：内联常量对象属性。
5. `inlineDecoderWrappers`：把 `var alias = decoder` 等别名/包装函数内联掉，
   使 decoder 调用点变成直接调用。
6. `VMDecoder`：构造时把字符串表 + decoder + rotator 生成压缩代码，缓存为
   `setupCode`（每个 AST 只构造一次）。
7. `inlineDecodedStrings`：`collectCalls()` 收集全部字面量参数的 decoder 调用，
   **一次性**拼成 `(() => { setup; return [calls...] })()` 送进沙箱，批量取回
   解码结果并替换为字面量。
8. 删除字符串表、rotator、decoder（`state.changes += 2 + decoders.length`）。
9. **不动点循环**：`applyTransformsUntilFixedPoint([mergeStrings, deadCode,
controlFlowObject, controlFlowSwitch], { noScope: true })`。

## 状态、缓存与输出

- **状态**：`TransformState.changes` 是唯一的污染标记。每个 transform 改写节点
  时自增它；不动点循环以「一整趟 0 改动」作为收敛判定，并返回
  `FixedPointState { changes, iterations, converged }`。
- **缓存**：
  - `VMDecoder.setupCode` 在构造时生成一次，所有 decoder 调用共享，因此整棵 AST
    只产生 **1 次**沙箱往返（追踪样例中 6 个调用一次批量求值）。
  - babel 的 NodePath/Scope 按节点缓存：deobfuscate 的清理循环用 `noScope: true`
    跑，但 `deadCode` 读取 `path.scope` 仍安全，因为前面带 scope 的遍历
    （`inlineObjectProps` 等）已经在路径缓存里留下了 Scope。直接对新鲜 AST 以
    `noScope: true` 跑 `deadCode` 会崩溃——单元测试里因此不关闭 scope。
- **输出**：decoder 调用被替换为字面量（解码结果不是字符串时附加
  `webcrack:decode_error` 注释），字符串表/rotator/decoder 被删除，清理循环做
  常量折叠与死分支消除，最终由 `generate` 打印。

## 为什么循环会收敛

循环体里的四个 transform 各自只在能**严格降低某个测度**时才改写：

- `mergeStrings`：`"a" + "b"` → `"ab"`，每趟减少一个 BinaryExpression 节点；
- `deadCode`：删除恒假分支或把恒真分支内联，每趟减少语句/表达式节点；
- `controlFlowObject` / `controlFlowSwitch`：把控制流平坦化的 switch/while
  结构还原为顺序语句，每趟减少循环与 switch 节点。

AST 节点数与字符串拼接次数都是非负整数且单调不增，测度有下界，所以「改动次数

> 0」不可能无限持续——循环必然在有限趟内达到一整趟 0 改动（不动点）。实测
> 现有全部样例在第 2 趟（验证趟）即收敛，快照无一变化。

收敛判定本身是幂等保证：收敛后再跑一遍同一循环，第一趟就是 0 改动，
`iterations === 1`、`changes === 0`（`transform.test.ts` 与
`fixed-point.test.ts` 的幂等用例）。

尽管如此，收敛性依赖「每个 transform 都朝不动点方向走」这一前提，对对抗性输入
不成立（见「最危险反例」），因此循环还带 `maxIterations`（默认 10）硬上限：
达到上限即停止并返回 `converged: false`，用 debug 日志输出趟数与累计改动数，
保证 deobfuscate 永远终止且上下文可诊断。

## 哪些节点改动会让之前失败的 transform 变得可用

transform 之间存在明确的使能（enabling）链，这正是需要循环/重跑的原因：

- `inlineDecoderWrappers` → `inlineDecodedStrings`：`var alias = dec; alias(1)`
  的别名被内联成 `dec(1)` 后，`collectCalls` 的直接调用匹配才命中。
- `Decoder.collectCalls` 自身：`dec(t ? 1 : 2)` 被改写成 `t ? dec(1) : dec(2)`，
  把条件参数拆成两个字面量调用，下一轮收集才可解码。
- `inlineDecodedStrings` → `mergeStrings`：`dec(0x101) + dec(0x102)` 解码为
  `'Hello' + ' World!'` 后才能折叠成 `'Hello World!'`。
- `mergeStrings` → `deadCode`：`if ('a' + 'b' === 'ab')` 的左操作数折叠成
  `'ab'` 后，测试表达式才匹配 `stringLiteral === stringLiteral`，死分支才能
  被删除（追踪样例的主路径）。
- `deadCode` → `controlFlowObject/Switch`：死分支删除后露出的顺序语句块，
  才可能匹配控制流平坦化的结构模式。

## 沙箱如何阻断外部能力

`createNodeSandbox`（`packages/webcrack/src/deobfuscate/vm.ts`）用 isolated-vm
为**每次求值**创建独立的 V8 isolate 与全新 context：

- 隔离的 context 里没有任何宿主能力：`process`、`require`、`module`、
  `global`、`fetch`、`XMLHttpRequest`、`setTimeout` 全部为 `undefined`
  （`vm.test.ts` 逐个断言），decoder/rotator 代码无法触达文件系统、网络或
  模块系统。
- `copy: true` 把返回值按值拷贝出 isolate，宿主不会拿到 isolate 内的活对象。
- `timeout`（默认 10s，可配置）让死循环的 rotator 也会以
  `Script execution timed out` 拒绝，而不是挂起整个进程。
- try/finally 保证 eval 抛错时 `context.release()` 与 `isolate.dispose()` 仍被
  执行；每次调用新建 isolate，所以被污染的 isolate 不会影响后续解码
  （`vm.test.ts` 的失败恢复用例：超时 → 抛错 → 下一次求值仍正常）。

沙箱输入/输出（追踪样例实测）：

- 输入：`(() => { <字符串表>;<decoder>;<rotator>; return [dec(0x104),…,dec(0x103)] })()`，
  标识符已重命名为 `__STRING_ARRAY__`/`__DECODE_0__`，紧凑打印以绕过
  self-defending 的 `toString` 正则检查。
- 输出：`['1xQ','2yZ','log','Hello',' World!','dead']`——rotator 在沙箱内
  真实执行，返回的是旋转后的字符串表内容。注意前两个值来自 rotator 循环体里
  的 `parseInt(dec(0x104))` 调用，它们同样被收集、内联，随后随 rotator 一起删除。

## 错误传播

- 沙箱求值错误（语法错误、decoder 主动 `throw`、超时）原样拒绝，调用方拿到
  完整错误。
- `VMDecoder.decode` 对两类已知环境错误降级为空数组：isolated-vm 未安装
  （`ERR_MODULE_NOT_FOUND`）与原生模块版本不匹配（`undefined symbol` /
  `Segmentation fault` / `No native build`），并写 debug 日志；其余错误一律
  重新抛出，抛出前把生成的 vm 代码写入 debug 日志保留诊断上下文。
- 不动点循环不吞错误：transform 抛出的异常直接向上传播；只有「达到迭代上限」
  这一非致命情况以 `converged: false` + debug 日志报告。

## 追踪样例（rotator + 别名 decoder + 常量折叠 + 死分支）

`fixed-point.test.ts` 的内联样例：6 元素字符串表、旋转 3 次后目标值才匹配的
rotator、`var alias = d` 别名 decoder、`if ('a' + 'b' === 'ab')` 死分支。
记录型沙箱包装 `createNodeSandbox` 后实测：

- 排程：字符串表/rotator/decoder 依次被识别并重命名；别名内联后收集到 6 个
  decoder 调用；沙箱恰好被调用 **1 次**；随后字符串表、rotator、decoder 被删除；
  清理循环把 `'a' + 'b'` 折叠为 `'ab'`、删除死分支、把解码结果合并成
  `'Hello World!'`。
- 污染标记：首趟 deobfuscate `changes = 21`；对结果再跑一次 deobfuscate
  `changes = 0` 且输出逐字节相同（幂等）。
- 输出：`console["log"]("Hello World!");`，与 `webcrack()` 入口的结果一致。

## 最危险反例

两个互相撤销的 transform（A 把 `'a'` 改成 `'b'`，B 把 `'b'` 改回 `'a'`）：
每一趟都上报改动、但净效果是恒等，基于改动计数的收敛判定**永远**不会触发。
没有迭代上限时，deobfuscate 会在对抗性输入上死循环。沙箱侧的对偶反例是
decoder/rotator 里的 `while (true) {}`：没有超时时求值永不返回。
两者分别由 `transform.test.ts` 的 oscillation 用例和 `vm.test.ts` 的 timeout
用例锁定。

## 可执行反证索引

- `packages/webcrack/src/ast-utils/test/transform.test.ts`：收敛 + 幂等、
  跨趟使能（3 趟收敛）、互相撤销（5 趟后 `converged: false`）、无界增长、
  默认上限 10。
- `packages/webcrack/src/deobfuscate/test/fixed-point.test.ts`：排程与沙箱 I/O
  追踪、deobfuscate 幂等、`webcrack()` 对称入口一致性。
- `packages/webcrack/src/deobfuscate/test/vm.test.ts`：宿主能力阻断、超时终止、
  错误传播、失败恢复、`VMDecoder` 错误降级路径。
