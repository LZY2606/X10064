import type { Node, TraverseOptions, Visitor } from '@babel/traverse';
import traverse, { visitors } from '@babel/traverse';
import debug from 'debug';

const logger = debug('webcrack:transforms');

export async function applyTransformAsync<TOptions>(
  ast: Node,
  transform: AsyncTransform<TOptions>,
  options?: TOptions,
): Promise<TransformState> {
  logger(`${transform.name}: started`);
  const state: TransformState = { changes: 0 };

  await transform.run?.(ast, state, options);
  if (transform.visitor)
    traverse(ast, transform.visitor(options), undefined, state);

  logger(`${transform.name}: finished with ${state.changes} changes`);
  return state;
}

export function applyTransform<TOptions>(
  ast: Node,
  transform: Transform<TOptions>,
  options?: TOptions,
): TransformState {
  logger(`${transform.name}: started`);
  const state: TransformState = { changes: 0 };
  transform.run?.(ast, state, options);

  if (transform.visitor) {
    const visitor = transform.visitor(
      options,
    ) as TraverseOptions<TransformState>;
    visitor.noScope = !transform.scope;
    traverse(ast, visitor, undefined, state);
  }

  logger(`${transform.name}: finished with ${state.changes} changes`);
  return state;
}

export function applyTransforms(
  ast: Node,
  transforms: Transform[],
  options: { noScope?: boolean; name?: string; log?: boolean } = {},
): TransformState {
  options.log ??= true;
  const name = options.name ?? transforms.map((t) => t.name).join(', ');
  if (options.log) logger(`${name}: started`);
  const state: TransformState = { changes: 0 };

  for (const transform of transforms) {
    transform.run?.(ast, state);
  }

  const traverseOptions = transforms.flatMap((t) => t.visitor?.() ?? []);
  if (traverseOptions.length > 0) {
    const visitor: TraverseOptions<TransformState> =
      visitors.merge(traverseOptions);
    visitor.noScope = options.noScope || transforms.every((t) => !t.scope);
    traverse(ast, visitor, undefined, state);
  }

  if (options.log) logger(`${name}: finished with ${state.changes} changes`);
  return state;
}

export interface FixedPointState extends TransformState {
  /**
   * How many passes over the AST were executed,
   * including the final pass that made no changes.
   */
  iterations: number;
  /**
   * True when a full pass made zero changes (fixed point reached),
   * false when `maxIterations` was hit first.
   */
  converged: boolean;
}

/**
 * Repeatedly applies the given transforms until a full pass makes no more
 * changes (fixed point) or `maxIterations` is reached.
 *
 * Convergence is detected by a pass with zero changes, so when this returns
 * with `converged: true` the loop is idempotent: running it again would be a
 * no-op. When the transforms oscillate (e.g. two transforms undo each other),
 * the loop still terminates after `maxIterations` passes and reports
 * `converged: false` instead of looping forever.
 */
export function applyTransformsUntilFixedPoint(
  ast: Node,
  transforms: Transform[],
  options: {
    maxIterations?: number;
    noScope?: boolean;
    name?: string;
    log?: boolean;
  } = {},
): FixedPointState {
  const maxIterations = options.maxIterations ?? 10;
  const name = options.name ?? transforms.map((t) => t.name).join(', ');
  const log = options.log ?? true;
  if (log)
    logger(
      `${name}: fixed-point loop started (max ${maxIterations} iterations)`,
    );

  const state: FixedPointState = {
    changes: 0,
    iterations: 0,
    converged: false,
  };
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const pass = applyTransforms(ast, transforms, {
      noScope: options.noScope,
      name,
      log,
    });
    state.changes += pass.changes;
    state.iterations = iteration;
    if (pass.changes === 0) {
      state.converged = true;
      break;
    }
  }
  if (!state.converged) {
    logger(
      `${name}: no fixed point after ${maxIterations} iterations (${state.changes} changes), giving up`,
    );
  }
  return state;
}

export function mergeTransforms(options: {
  name: string;
  tags: Tag[];
  transforms: Transform[];
}): Transform {
  return {
    name: options.name,
    tags: options.tags,
    scope: options.transforms.some((t) => t.scope),
    visitor() {
      return visitors.merge(
        options.transforms.flatMap((t) => t.visitor?.() ?? []),
      );
    },
  };
}

export interface TransformState {
  changes: number;
}

export interface Transform<TOptions = unknown> {
  name: string;
  tags: Tag[];
  scope?: boolean;
  run?: (ast: Node, state: TransformState, options?: TOptions) => void;
  visitor?: (options?: TOptions) => Visitor<TransformState>;
}

export interface AsyncTransform<TOptions = unknown> extends Omit<
  Transform<TOptions>,
  'run'
> {
  run?: (ast: Node, state: TransformState, options?: TOptions) => Promise<void>;
}

export type Tag = 'safe' | 'unsafe';
