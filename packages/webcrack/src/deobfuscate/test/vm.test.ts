import { parse } from '@babel/parser';
import { describe, expect, test } from 'vitest';
import { findDecoders } from '../decoder';
import { findStringArray } from '../string-array';
import type { Sandbox } from '../vm';
import { VMDecoder, createNodeSandbox } from '../vm';

describe('createNodeSandbox', () => {
  test('evaluates code and copies the result out of the isolate', async () => {
    const sandbox = createNodeSandbox();
    expect(await sandbox('1 + 2')).toBe(3);
    expect(await sandbox('({ a: [1, "b"] })')).toEqual({ a: [1, 'b'] });
  });

  test('blocks access to host capabilities', async () => {
    const sandbox = createNodeSandbox();
    // The isolate has no Node.js or browser host objects, so decoder code
    // cannot escape to the file system, network or module system.
    for (const name of [
      'process',
      'require',
      'module',
      'global',
      'fetch',
      'XMLHttpRequest',
      'setTimeout',
    ]) {
      expect(await sandbox(`typeof ${name}`)).toBe('undefined');
    }
    expect(await sandbox('typeof globalThis.process')).toBe('undefined');
  });

  test('terminates infinite loops via the timeout', async () => {
    const sandbox = createNodeSandbox({ timeout: 100 });
    await expect(sandbox('while (true) {}')).rejects.toThrow(/timed out/i);
  });

  test('propagates evaluation errors', async () => {
    const sandbox = createNodeSandbox();
    await expect(sandbox('throw new Error("boom")')).rejects.toThrow(/boom/);
    await expect(sandbox('not valid js (')).rejects.toThrow();
  });

  test('recovers from a failed eval because each call uses a fresh isolate', async () => {
    const sandbox = createNodeSandbox({ timeout: 100 });
    await expect(sandbox('while (true) {}')).rejects.toThrow(/timed out/i);
    await expect(sandbox('throw new Error("boom")')).rejects.toThrow(/boom/);
    expect(await sandbox('40 + 2')).toBe(42);
  });
});

describe('VMDecoder', () => {
  function createVM(sandbox: Sandbox) {
    const ast = parse(
      `
      function getStrings() {
        var arr = ['a', 'b'];
        getStrings = function () {
          return arr;
        };
        return getStrings();
      }
      function d(i) {
        var arr = getStrings();
        return arr[i];
      }
      d(0);
      d(1);
    `,
      { sourceType: 'unambiguous' },
    );
    const stringArray = findStringArray(ast)!;
    const decoders = findDecoders(stringArray);
    return { vm: new VMDecoder(sandbox, stringArray, decoders), decoders };
  }

  test('decodes calls through the sandbox', async () => {
    const { vm, decoders } = createVM(createNodeSandbox());
    const calls = decoders.flatMap((decoder) => decoder.collectCalls());
    expect(calls).toHaveLength(2);
    await expect(vm.decode(calls)).resolves.toEqual(['a', 'b']);
  });

  test('rethrows sandbox errors to keep the diagnostic context', async () => {
    const error = new Error('sandbox exploded');
    const { vm } = createVM(() => Promise.reject(error));
    await expect(vm.decode([])).rejects.toBe(error);
  });

  test('returns an empty array when isolated-vm is unavailable', async () => {
    const moduleNotFound = Object.assign(new Error('Cannot find module'), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const { vm } = createVM(() => Promise.reject(moduleNotFound));
    await expect(vm.decode([])).resolves.toEqual([]);
  });

  test('returns an empty array on isolated-vm version mismatch', async () => {
    const { vm } = createVM(() =>
      Promise.reject(new Error('No native build was found')),
    );
    await expect(vm.decode([])).resolves.toEqual([]);
  });
});
