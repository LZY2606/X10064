# webcrack：不动点变换循环、副作用沙箱与终止判定

本文分析 webcrack 的 deobfuscation 管线：多个 transform 如何被排程并反复作用到同一棵
AST 上、污染标记（dirty mark）如何驱动重跑判定、受限沙箱如何执行
decoder/rotator 取回字符串表，以及整个循环为何收敛、在何处终止。
所有论断都由 `packages/webcrack/src/deobfuscate/test/fixed-point.test.ts`
中的可执行反证支撑（见文末索引）。

## 1. 入口与排程（Entry & Scheduling）

管线有两个对称入口，测试对两者分别验证：

- 公共 API：`webcrack(code, options)`（`packages/webcrack/src/index.ts`）。
  它把全部工作组织为一个有序的 stage 数组，依次执行：
  `parse` → `prepare`（`blockStatements` / `sequence` /
  `splitVariableDeclarations`）→ `deobfuscate` → `unminify`（`transpile` +
  `unminify` 合并遍历）→ `mangle` → `selfDefending` / `debugProtection` /
  `jsx` → `mergeObjectAssignments` / `evaluateGlobals` → `generate` →
  `unpack`。每个 stage 都是数组元素，插件通过 `afterXxx` 钩子插入同一序列。
- transform 级入口：`applyTransformAsync(ast, deobfuscate, sandbox)`
  （`packages/webcrack/src/ast-utils/transform.ts`），直接对解析后的 AST
  跑 `packages/webcrack/src/deobfuscate/index.ts` 中的 `deobfuscate`
  transform，便于在不经过完整管线的情况下观察状态与污染标记。

`deobfuscate` 内部按固定分层顺序调度子 transform：

1. `findStringArray` / `findArrayRotator` / `findDecoders`：纯检测，
   把字符串表函数重命名为 `__STRING_ARRAY__`、decoder 重命名为
   `__DECODE_<n>__`，让后续匹配按名字 O(1) 命中。
2. `inlineObjectProps`、`inlineDecoderWrappers`（每个 decoder 一次）：
   消除别名间接层。
3. `new VMDecoder(...)`：一次性生成 setup 代码（字符串表 + decoder +
   rotator，compact 输出以规避 self-defending 的 `toString` 正则）。
4. `inlineDecodedStrings`：收集全部字面量调用，**一次**沙箱求值批量解码。
5. 删除字符串表、rotator、decoder 节点。
6. `mergeStrings` / `deadCode` / `controlFlowObject` / `controlFlowSwitch`
   合并为单次遍历做清理。

## 2. 状态与污染标记（State & Dirty Marking）

`TransformState.changes`（`packages/webcrack/src/ast-utils/transform.ts`）
是贯穿所有 transform 的污染标记：任何节点改写（`replaceWith` / `remove` /
`replaceWithMultiple` 等）都会使其递增。它承担两个角色：

- **重跑条件**：`changes > 0` 表示本轮改写了 AST，上一轮因形状不匹配而
  失败的 transform 现在可能可用；`changes === 0` 表示到达不动点，再跑
  同样的 transform 不会有任何效果。
- **收敛证据**：`fixed-point.test.ts` 的
  `transform entry reaches a fixed point and resets the dirty mark`
  直接断言：第一遍 `changes > 0`，对同一棵 AST 跑第二遍
  `changes === 0` 且生成代码逐字节相同。

## 3. 缓存（Cache）

- 检测结果缓存：`findStringArray` / `findDecoders` / `findArrayRotator`
  每轮 deobfuscate 只跑一次；重命名（`renameFast`）后的绑定信息被
  `Decoder.collectCalls` 直接复用。
- 沙箱设置缓存：`VMDecoder.setupCode` 只生成一次；`decode()` 把所有收集到
  的调用拼进**单个**表达式在沙箱里求值一次。追踪测试
  （`schedules transforms, batches sandbox i/o and cleans up`）用包装过的
  `Sandbox` 记录输入输出，断言 13 个解码调用只产生 **1 次**沙箱往返。
- 遍历缓存：`mergeTransforms` / `applyTransforms` 把多个 visitor 合并成
  一次 AST 遍历（`visitors.merge`），避免每个 transform 各自全树游走。

## 4. 循环为何收敛（Why the Loop Converges）

把整套管线看作对 AST 的不动点迭代 `ast' = T(ast)`，收敛理由是：

1. **每个 transform 都是良基度量上的缩减**。可定义度量
   `μ = (节点数, 调用间接深度, 表达式复杂度)`：死代码/别名声明/字符串表/
   rotator/decoder 的删除严格减少节点数；别名内联与解码替换
   （`m(0x100)` → `"log"`）严格减少调用间接；`mergeStrings` 与常量折叠
   严格减少表达式深度。没有任何 transform 会重新引入字符串表、rotator
   或 decoder，因此 `μ` 单调递减且有下界，迭代必然终止。
2. **使能关系无环**。transform 之间的依赖是单向的：prepare → 检测 →
   别名内联 → 沙箱解码 → 节点清理 → 死代码/控制流清理。不存在
   "A 的产出让 B 可用、B 的产出又让 A 重做"的环。
3. **可执行的幂等证明**：`converges: re-running the full pipeline is
   idempotent` 断言 `webcrack(webcrack(sample).code).code` 与第一次输出
   完全相同——完整管线一遍即达不动点。

### 哪些节点改动让之前失败的 transform 变得可用

- `inlineDecoderWrappers`：`var m = decode; var n = m;` 的引用被改写为
  decoder 本名，使 `Decoder.collectCalls` 的
  `callExpression(identifier(name))` 匹配器第一次能看到这些调用点。
- `Decoder.collectCalls` 的条件抽取：`decode(flag ? 0x101 : 0x102)` 被
  改写为 `flag ? decode(0x101) : 0x102 分支`，把一个非字面量调用拆成两个
  可批量解码的字面量调用。
- `Decoder.collectCalls` 的标识符实参内联：`var n = 1; decode(n);` 经
  `inlineVariable` 变为 `decode(1);` 后才进入解码批次。
- 解码替换本身：`m(0x100)` → `"log"` 之后，`console["log"]` 才成为
  `computed-properties` 可静态求值的成员访问；`"abc" === "def"` 才成为
  `dead-code` 可求值的常量条件。
- `mergeStrings`：`"a" + "b"` → `"ab"` 让字符串表检测与死代码的字符串
  比较匹配器命中。
- `prepare` 阶段的 `blockStatements` / `sequence`：规范化语句形状，使
  `dead-code` 的 `IfStatement` 匹配器和控制流匹配器适用。

## 5. 沙箱如何阻断外部能力（Sandbox Isolation）

`createNodeSandbox`（`packages/webcrack/src/deobfuscate/vm.ts`）为每次求值
创建全新的 `isolated-vm` Isolate + Context：那是一块裸 V8 堆，里面没有
`process`、`require`、`fs`、网络或任何宿主对象；结果通过 `copy: true`
按值编组回宿主。因此即使被混淆样本在字符串表/decoder/rotator 里藏了
`process.exit(1)` 之类的载荷，也只会在隔离世界里抛
`ReferenceError: process is not defined`（测试
`sandbox isolate exposes no host capabilities` 证明）。

**终止判定（最大迭代保护）**：rotator 本质是 `while (!![])` 死循环，靠
校验和命中才 `break`。webcrack 把这段代码放进沙箱执行，等于把
"攻击者控制的循环" 引进自己的进程；`timeout: 10_000` 是唯一的最大迭代
保护——校验和永远不满足时 isolate 被强制终止，宿主事件循环不会被拖死。
测试 `max-iteration protection: non-halting rotator is killed by the
sandbox timeout` 用永不命中的校验和（333 → 334）证明管线以
`Script execution timed out` 拒绝而非挂起。

## 6. 错误传播（Error Propagation）

`VMDecoder.decode` 对错误分三类处理，全部保留可诊断上下文：

- `ERR_MODULE_NOT_FOUND`、isolated-vm 原生构建不匹配：降级为返回 `[]`
  并用 `debug('webcrack:deobfuscate')` 记录，deobfuscation 以 no-op 继续。
- 其他错误（含沙箱超时、isolate 内 ReferenceError）：记录生成的 vm 代码
  后**原样重抛**，沿 `applyTransformAsync` → stage 数组 → `webcrack()`
  的 promise 传播给调用方（测试 `sandbox errors propagate with their
  diagnostic context` 用自定义 sandbox 的 `boom: sandbox unreachable`
  验证逐字传播）。
- 单次调用软失败：批量结果中某个值不是字符串（如越界下标
  `m(0x999)` → `undefined`）时，该节点保留并加
  `/*webcrack:decode_error*/` 前导注释，同批次其余调用照常解码——部分
  失败不中止管线。

## 7. 输出（Output）

所有 stage 完成后 `generate(ast)` 产出最终代码；解码失败的节点带
`webcrack:decode_error` 注释；`unpack` 在代码生成之后复用同一棵 AST。
追踪样例（含 rotator、别名 decoder、常量折叠实参、死分支、越界调用）
的实测沙箱输入/输出与最终代码：

- 沙箱输入（单次）：`__STRING_ARRAY__` 字符串表 + `__DECODE_0__`
  decoder + rotator 的 setup 代码，以及 13 个收集到的调用组成的返回数组。
- 沙箱输出：`["111","222","log","hello world","log","secret","log",
  "secret","log","log",null,"hello world","secret"]`（`null` 是
  `undefined` 越界结果在 JSON 序列化下的形态）。
- 最终代码：全部调用点被替换为字符串字面量，rotator/decoder/字符串表/
  别名声明被删除，死分支 `if ("abc" === "def")` 被移除，越界调用保留为
  `/*webcrack:decode_error*/undefined`。

## 8. 可执行反证索引

`packages/webcrack/src/deobfuscate/test/fixed-point.test.ts`：

| 测试 | 证明 |
| --- | --- |
| `schedules transforms, batches sandbox i/o and cleans up` | 排程顺序、单次沙箱往返、解码替换、节点清理、死分支消除、软失败注释 |
| `converges: re-running the full pipeline is idempotent` | 完整管线幂等（不动点） |
| `transform entry reaches a fixed point and resets the dirty mark` | 污染标记归零、transform 级入口幂等 |
| `no string array: deobfuscate is a no-op` | 边界一侧：无字符串表时零改动 |
| `boundary: decoder without rotator still decodes` | 边界另一侧：rotator 缺失时解码仍成立 |
| `max-iteration protection: non-halting rotator is killed by the sandbox timeout` | 最大迭代保护：永不终止的 rotator 被拒绝而非挂起 |
| `sandbox isolate exposes no host capabilities` | 沙箱阻断 `process` 等宿主能力 |
| `sandbox errors propagate with their diagnostic context` | 失败恢复：自定义沙箱错误逐字传播 |

运行方式：`corepack pnpm test fixed-point`（单独定位）或
`corepack pnpm test`（全套）。
