import { parse } from '@babel/parser';
import { describe, expect, test } from 'vitest';
import { applyTransformAsync, generate } from '../../ast-utils';
import { webcrack } from '../../index';
import type { Sandbox } from '../index';
import deobfuscate, { createNodeSandbox } from '../index';

// Contains an array rotator, an aliased decoder, constant-foldable string
// concatenations and a dead branch.
const sample = `
function getStrings() {
  var arr = ['dead', '1xQ', '2yZ', 'log', 'Hello', ' World!'];
  getStrings = function () {
    return arr;
  };
  return getStrings();
}
(function (b, e) {
  var k = d, f = b();
  while (!![]) {
    try {
      var g = parseInt(k(0x104)) / 1 + parseInt(k(0x105)) / 2;
      if (g === e) break;
      else f.push(f.shift());
    } catch (h) {
      f.push(f.shift());
    }
  }
})(getStrings, 2);
function d(a, b) {
  var e = getStrings();
  return (d = function (f, g) {
    f = f - 0x100;
    return e[f];
  }, d(a, b));
}
var alias = d;
if ('a' + 'b' === 'ab') {
  console[alias(0x100)](alias(0x101) + alias(0x102));
} else {
  console.log(alias(0x103));
}
`;

function recordingSandbox() {
  const calls: { input: string; output: unknown }[] = [];
  const nodeSandbox = createNodeSandbox();
  const sandbox: Sandbox = async (code) => {
    const output = await nodeSandbox(code);
    calls.push({ input: code, output });
    return output;
  };
  return { calls, sandbox };
}

const parseCode = (code: string) =>
  parse(code, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });

describe('deobfuscate fixed-point pipeline', () => {
  test('schedules transforms and batches decoder calls through the sandbox', async () => {
    const { calls, sandbox } = recordingSandbox();
    const ast = parseCode(sample);
    const state = await applyTransformAsync(ast, deobfuscate, sandbox);

    // Sandbox I/O: all decoder calls are evaluated in a single batched eval.
    expect(calls).toHaveLength(1);
    const { input, output } = calls[0];
    // The setup code contains the string array, the rotator loop and the
    // decoder (renamed to avoid collisions with the evaluated code).
    expect(input).toContain("'dead','1xQ','2yZ','log','Hello',' World!'");
    expect(input).toContain('while(!![])');
    expect(input).toContain('push(f.shift())');
    expect(input).toContain('__DECODE_0__');
    expect(input).toContain('return [');
    // The rotator runs inside the sandbox, so the decoded values reflect the
    // rotated string array.
    expect(output).toEqual(['1xQ', '2yZ', 'log', 'Hello', ' World!', 'dead']);

    // Constant folding + dead branch removal + decoder inlining.
    expect(generate(ast)).toBe('console["log"]("Hello World!");');
    expect(state.changes).toBeGreaterThan(0);
  });

  test('is idempotent: a second run makes no changes', async () => {
    const { sandbox } = recordingSandbox();
    const ast = parseCode(sample);
    await applyTransformAsync(ast, deobfuscate, sandbox);
    const output = generate(ast);

    const secondRun = recordingSandbox();
    const second = await applyTransformAsync(
      ast,
      deobfuscate,
      secondRun.sandbox,
    );
    expect(second.changes).toBe(0);
    expect(generate(ast)).toBe(output);
    // The string array is gone, so the sandbox is not needed anymore.
    expect(secondRun.calls).toHaveLength(0);
  });

  test('produces the same deobfuscation through the webcrack entry', async () => {
    const result = await webcrack(sample, {
      unpack: false,
      unminify: false,
      jsx: false,
    });
    expect(result.code).toBe('console["log"]("Hello World!");');
  });
});
