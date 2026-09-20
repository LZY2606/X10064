import { parse } from '@babel/parser';
import { describe, expect, test } from 'vitest';
import { applyTransformAsync, generate } from '../../ast-utils';
import { webcrack } from '../../index';
import deobfuscate, { createNodeSandbox, type Sandbox } from '../index';

/**
 * Exercises the deobfuscate pipeline as a fixed-point loop:
 * array rotator + aliased decoder + constant-folded decoder arguments
 * + a dead branch, all in one sample.
 *
 * The string array is pre-rotated by one position so the rotator iife
 * must actually run (push/shift once) before the decoder indices line up:
 *   rotation 0: ['222', 'log', 'hello world', 'secret', '111']
 *   rotation 1: ['log', 'hello world', 'secret', '111', '222']
 * After the rotation, decode(0x100..0x102) map to 'log'/'hello world'/'secret'
 * and the rotator's checksum parseInt(dec(0x103)) + parseInt(dec(0x104))
 * equals 111 + 222 = 333, which is the break condition.
 */
const SAMPLE = `
function getArray() {
  var arr = ['222', 'log', 'hello world', 'secret', '111'];
  getArray = function () {
    return arr;
  };
  return getArray();
}
(function (array, target) {
  var dec = decode;
  var arr = array();
  while (!![]) {
    try {
      var sum = parseInt(dec(0x103)) + parseInt(dec(0x104));
      if (sum === target) break;
      else arr.push(arr.shift());
    } catch (e) {
      arr.push(arr.shift());
    }
  }
})(getArray, 333);
function decode(a, b) {
  var arr = getArray();
  return (
    (decode = function (f, g) {
      f = f - 0x100;
      var h = arr[f];
      return h;
    }),
    decode(a, b)
  );
}
function hi() {
  var m = decode;
  var n = m;
  console[m(0x100)](n(0x101));
  console[m(0x100)](m(0x100 + 0x2));
  if ('abc' === 'def') {
    console.log('dead');
  } else {
    console[m(0x100)](m(0x102));
  }
  var flag = true;
  console[m(0x100)](m(flag ? 0x101 : 0x102));
  console[m(0x100)](m(0x999));
}
hi();
`;

/** Same as SAMPLE but the rotator checksum can never be satisfied. */
const NON_HALTING_SAMPLE = SAMPLE.replace(
  '})(getArray, 333);',
  '})(getArray, 334);',
);

/** Rotator that tries to escape to a host capability before looping. */
const HOST_PROBE_SAMPLE = SAMPLE.replace(
  'var arr = array();\n  while',
  'var arr = array();\n  process.exit(1);\n  while',
);

interface SandboxTrace {
  input: string;
  output: unknown;
}

function recordingSandbox(): { sandbox: Sandbox; traces: SandboxTrace[] } {
  const traces: SandboxTrace[] = [];
  const inner = createNodeSandbox();
  return {
    traces,
    sandbox: async (code) => {
      const output = await inner(code);
      traces.push({ input: code, output });
      return output;
    },
  };
}

describe('fixed-point deobfuscation loop', () => {
  test('schedules transforms, batches sandbox i/o and cleans up', async () => {
    const { sandbox, traces } = recordingSandbox();
    const result = await webcrack(SAMPLE, { sandbox });

    // The vm decoder collects all literal calls and evaluates them in a
    // single sandbox round-trip (cached setup code, batched decode).
    expect(traces).toHaveLength(1);
    const trace = traces[0];
    // Sandbox input: string array + renamed decoder + rotator setup code.
    expect(trace.input).toContain('__STRING_ARRAY__');
    expect(trace.input).toContain('__DECODE_0__');
    expect(trace.input).toContain('push');
    expect(trace.input).toContain('shift');
    // Sandbox output: the decoded values in call order, including the
    // constant-folded argument 0x100 + 0x2 and the out-of-range 0x999.
    expect(trace.output).toEqual(
      expect.arrayContaining(['log', 'hello world', 'secret', undefined]),
    );

    // Decoder calls are replaced with the decoded strings.
    expect(result.code).toContain('console.log("hello world")');
    expect(result.code).toContain('console.log("secret")');
    // Aliases, decoder, string array and rotator are all gone.
    expect(result.code).not.toContain('__DECODE_0__');
    expect(result.code).not.toContain('__STRING_ARRAY__');
    expect(result.code).not.toContain('getArray');
    // Dead branch removed, live branch kept.
    expect(result.code).not.toContain('dead');
    // Conditional call was split so both branches decode.
    expect(result.code).toContain('flag ? "hello world" : "secret"');
    // Out-of-range index fails soft: marked, not crashed.
    expect(result.code).toContain('/*webcrack:decode_error*/undefined');
  });

  test('converges: re-running the full pipeline is idempotent', async () => {
    const once = await webcrack(SAMPLE);
    const twice = await webcrack(once.code);
    expect(twice.code).toBe(once.code);
  });

  test('transform entry reaches a fixed point and resets the dirty mark', async () => {
    const ast = parse(SAMPLE);
    const first = await applyTransformAsync(
      ast,
      deobfuscate,
      createNodeSandbox(),
    );
    // Pollution marking: the first pass reports a positive change count.
    expect(first.changes).toBeGreaterThan(0);
    const code = generate(ast);
    expect(code).toContain('"hello world"');

    // Second pass over the same AST: nothing left to match, zero changes.
    const second = await applyTransformAsync(
      ast,
      deobfuscate,
      createNodeSandbox(),
    );
    expect(second.changes).toBe(0);
    expect(generate(ast)).toBe(code);
  });

  test('no string array: deobfuscate is a no-op', async () => {
    const ast = parse('const a = 1;\nconsole.log(a);');
    const before = generate(ast);
    const state = await applyTransformAsync(
      ast,
      deobfuscate,
      createNodeSandbox(),
    );
    expect(state.changes).toBe(0);
    expect(generate(ast)).toBe(before);
  });

  test('boundary: decoder without rotator still decodes', async () => {
    const code = `
      function getArray() {
        var arr = ['log', 'hello world'];
        getArray = function () {
          return arr;
        };
        return getArray();
      }
      function decode(a, b) {
        var arr = getArray();
        return (
          (decode = function (f, g) {
            f = f - 0x100;
            var h = arr[f];
            return h;
          }),
          decode(a, b)
        );
      }
      console[decode(0x100)](decode(0x101));
    `;
    const result = await webcrack(code);
    expect(result.code).toBe('console.log("hello world");');
  });

  test('sandbox errors propagate with their diagnostic context', async () => {
    const failing: Sandbox = () =>
      Promise.reject(new Error('boom: sandbox unreachable'));
    await expect(webcrack(SAMPLE, { sandbox: failing })).rejects.toThrow(
      'boom: sandbox unreachable',
    );
  });

  test('sandbox isolate exposes no host capabilities', async () => {
    // `process` does not exist inside the isolate, so the rotator's
    // escape attempt fails instead of killing the host.
    await expect(webcrack(HOST_PROBE_SAMPLE)).rejects.toThrow(
      /process is not defined/,
    );
  });

  test(
    'max-iteration protection: non-halting rotator is killed by the sandbox timeout',
    { timeout: 30_000 },
    async () => {
      await expect(webcrack(NON_HALTING_SAMPLE)).rejects.toThrow(/timed out/i);
    },
  );
});
