import { parse } from '@babel/parser';
import * as t from '@babel/types';
import { describe, expect, test } from 'vitest';
import type { Transform } from '..';
import { applyTransformsUntilFixedPoint, generate } from '..';
import deadCode from '../../deobfuscate/dead-code';
import mergeStrings from '../../unminify/transforms/merge-strings';

const parseCode = (code: string) =>
  parse(code, { sourceType: 'unambiguous', allowReturnOutsideFunction: true });

describe('applyTransformsUntilFixedPoint', () => {
  test('converges and is idempotent for the deobfuscate cleanup transforms', () => {
    const ast = parseCode(`
      if ("a" + "b" === "ab") {
        console.log("He" + "llo");
      } else {
        console.log("dead");
      }
    `);
    const transforms = [mergeStrings, deadCode];

    const first = applyTransformsUntilFixedPoint(ast, transforms, {
      log: false,
    });
    expect(first.converged).toBe(true);
    const output = generate(ast);
    expect(output).toBe('console.log("Hello");');

    // A converged loop is a no-op when applied again.
    const second = applyTransformsUntilFixedPoint(ast, transforms, {
      log: false,
    });
    expect(second).toMatchObject({
      changes: 0,
      iterations: 1,
      converged: true,
    });
    expect(generate(ast)).toBe(output);
  });

  test('re-runs transforms until no transform reports changes', () => {
    // to-string creates a node that rename-string can only match in a later
    // pass, because replaceWith + skip defers the new node to the next pass.
    const toString: Transform = {
      name: 'to-string',
      tags: ['unsafe'],
      visitor: () => ({
        NumericLiteral: {
          exit(path) {
            if (path.node.value !== 1) return;
            path.replaceWith(t.stringLiteral('1'));
            path.skip();
            this.changes++;
          },
        },
      }),
    };
    const renameString: Transform = {
      name: 'rename-string',
      tags: ['unsafe'],
      visitor: () => ({
        StringLiteral: {
          exit(path) {
            if (path.node.value !== '1') return;
            path.node.value = 'done';
            this.changes++;
          },
        },
      }),
    };

    const ast = parseCode('let s = 1;');
    const state = applyTransformsUntilFixedPoint(
      ast,
      [toString, renameString],
      {
        log: false,
      },
    );
    // pass 1: to-string; pass 2: rename-string; pass 3: no changes
    expect(state).toMatchObject({ changes: 2, iterations: 3, converged: true });
    expect(generate(ast)).toBe('let s = "done";');
  });

  test('stops at maxIterations when two transforms undo each other', () => {
    // The most dangerous fixed-point counterexample: each transform reports a
    // change, but the net effect of a pass is the identity, so the change
    // counter can never detect convergence. Only the iteration cap terminates
    // the loop.
    const flip: Transform = {
      name: 'flip',
      tags: ['unsafe'],
      visitor: () => ({
        StringLiteral: {
          exit(path) {
            if (path.node.value !== 'a') return;
            path.node.value = 'b';
            this.changes++;
          },
        },
      }),
    };
    const flop: Transform = {
      name: 'flop',
      tags: ['unsafe'],
      visitor: () => ({
        StringLiteral: {
          exit(path) {
            if (path.node.value !== 'b') return;
            path.node.value = 'a';
            this.changes++;
          },
        },
      }),
    };

    const ast = parseCode('let s = "a";');
    const state = applyTransformsUntilFixedPoint(ast, [flip, flop], {
      log: false,
      maxIterations: 5,
    });
    expect(state).toMatchObject({
      changes: 10,
      iterations: 5,
      converged: false,
    });
    // The net effect of each pass is the identity.
    expect(generate(ast)).toBe('let s = "a";');
  });

  test('stops at maxIterations for unbounded growth', () => {
    const grow: Transform = {
      name: 'grow',
      tags: ['unsafe'],
      visitor: () => ({
        StringLiteral: {
          exit(path) {
            path.node.value += '!';
            this.changes++;
          },
        },
      }),
    };

    const ast = parseCode('let s = "x";');
    const state = applyTransformsUntilFixedPoint(ast, [grow], {
      log: false,
      maxIterations: 3,
    });
    expect(state).toMatchObject({
      changes: 3,
      iterations: 3,
      converged: false,
    });
    expect(generate(ast)).toBe('let s = "x!!!";');
  });

  test('default maxIterations is 10', () => {
    const grow: Transform = {
      name: 'grow',
      tags: ['unsafe'],
      visitor: () => ({
        StringLiteral: {
          exit(path) {
            path.node.value += '!';
            this.changes++;
          },
        },
      }),
    };

    const ast = parseCode('let s = "x";');
    const state = applyTransformsUntilFixedPoint(ast, [grow], { log: false });
    expect(state).toMatchObject({ iterations: 10, converged: false });
  });
});
