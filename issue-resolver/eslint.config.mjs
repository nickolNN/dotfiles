import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import tseslint from 'typescript-eslint';

// Domain values are read from the source that declares them, never restated
// here: a rule that keeps its own copy of a closed set drifts from it.
const SHARED_SRC = new URL('./shared/src/', import.meta.url).pathname;

function sharedSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sharedSources(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

const DOMAIN_DECL = /export const ([A-Z]\w*)\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\s*as const\)/g;

/** value -> domain names that declare it (a value may belong to several). */
const CLOSED_SET_VALUES = new Map();
for (const file of sharedSources(SHARED_SRC)) {
  const source = readFileSync(file, 'utf8');
  let match;
  while ((match = DOMAIN_DECL.exec(source)) !== null) {
    for (const [, value] of match[2].matchAll(/:\s*'([^']*)'/g)) {
      const domains = CLOSED_SET_VALUES.get(value) ?? [];
      if (!domains.includes(match[1])) domains.push(match[1]);
      CLOSED_SET_VALUES.set(value, domains);
    }
  }
}

// Comparisons the rule must not flag, with the reason each one is not a
// closed-set read. Adding a line here is a decision, not a convenience.
const CLOSED_SET_EXCEPTIONS = [
  { file: 'backend/src/docker/local-controller.ts', value: 'max', reason: 'docker --memory string' },
  { file: 'backend/src/pi/agent-session.ts', value: 'question', reason: 'SessionEvent discriminant (inline on purpose)' },
  { file: 'backend/src/pi/rpc-event-map.ts', value: 'error', reason: 'pi RPC event discriminant' },
  { file: 'backend/src/pi/rpc-session.ts', value: 'prompt', reason: 'pi RPC command name, not SessionCommandSource' },
  { file: 'backend/src/pi/session-paths.ts', value: 'off', reason: 'PI_* env value' },
  { file: 'backend/src/pi/session-paths.ts', value: 'false', reason: 'PI_* env value' },
  { file: 'backend/src/workflow/iteration/step-execution.ts', value: 'question', reason: 'SessionEvent discriminant (inline on purpose)' },
  { file: 'frontend/src/components/artifacts-modal/preview-kind.ts', value: 'html', reason: 'file extension, not DesiredResult' },
  { file: 'frontend/src/components/artifacts-modal/preview-kind.ts', value: 'md', reason: 'file extension, not DesiredResult' },
  { file: 'frontend/src/views/task-detail/useAgentChat.ts', value: 'prompt', reason: 'screen-local SendMode union, not SessionCommandSource' },
  { file: 'frontend/src/views/task-detail/useQuestionFeed.ts', value: 'question', reason: 'SessionEvent discriminant (inline on purpose)' },
];

// File-level waivers for the JSON-cast rule, one reason each. A waiver is
// narrower than it looks: it covers that HTTP engine only.
const JSON_CAST_EXCEPTIONS = [
  {
    file: 'frontend/src/api/endpoints/http.ts',
    reason: 'requestJson<T> is the single generic fetch engine; callers narrow its unknown result',
  },
];

function isCastExcepted(context) {
  const file = context.filename.replaceAll('\\', '/');
  return JSON_CAST_EXCEPTIONS.some((e) => file.endsWith(e.file) && e.reason.length > 0);
}

function isExcepted(context, value) {
  const file = context.filename.replaceAll('\\', '/');
  return CLOSED_SET_EXCEPTIONS.some(
    (e) => file.endsWith(e.file) && e.value === value && e.reason.length > 0,
  );
}

/** The operand a literal is compared against: `x`, `x.y`, `x?.y`. */
function operandOf(node) {
  let target = node.type === 'ChainExpression' ? node.expression : node;
  if (target.type === 'MemberExpression' || target.type === 'Identifier') return target;
  return undefined;
}

const closedSetLiterals = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Compare closed-set values against their domain constant, never a bare literal',
    },
    messages: {
      useConstant:
        "'{{value}}' belongs to {{domains}} — compare against the domain member instead.",
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        const rightIsLiteral = node.right.type === 'Literal';
        const literal = rightIsLiteral ? node.right : node.left;
        if (literal.type !== 'Literal' || typeof literal.value !== 'string') return;
        const domains = CLOSED_SET_VALUES.get(literal.value);
        if (!domains) return;
        if (!operandOf(rightIsLiteral ? node.left : node.right)) return;
        if (isExcepted(context, literal.value)) return;
        context.report({
          node: literal,
          messageId: 'useConstant',
          data: { value: literal.value, domains: domains.join(', ') },
        });
      },
    };
  },
};

const untrustedJsonCast = {
  meta: {
    type: 'problem',
    docs: {
      description: 'An HTTP JSON body is untrusted input: decode it, never cast it',
    },
    messages: {
      decode:
        '`as {{type}}` on a JSON response asserts a shape nobody checked — decode it with a predicate (see CODING_STANDARDS.md, "Untrusted input keeps three states").',
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        const inner = node.expression.type === 'AwaitExpression' ? node.expression.argument : node.expression;
        if (inner.type !== 'CallExpression') return;
        const callee = inner.callee;
        if (callee.type !== 'MemberExpression') return;
        const name = callee.property.type === 'Identifier' ? callee.property.name : undefined;
        if (name !== 'json') return;
        // Widening to unknown keeps the value untrusted, which is the target state.
        if (node.typeAnnotation.type === 'TSUnknownKeyword') return;
        if (isCastExcepted(context)) return;
        context.report({
          node,
          messageId: 'decode',
          data: { type: context.sourceCode.getText(node.typeAnnotation) },
        });
      },
    };
  },
};

const localPlugin = {
  meta: { name: 'issue-resolver' },
  rules: {
    'closed-set-literals': closedSetLiterals,
    'untrusted-json-cast': untrustedJsonCast,
  },
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      'backend/data/**',
      'frontend/e2e/**/test-results/**',
      '**/*.d.ts',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      'no-nested-ternary': 'error',
      'max-len': [
        'error',
        {
          code: 100,
          tabWidth: 2,
          ignoreUrls: true,
          ignoreStrings: true,
          ignoreTemplateLiterals: true,
          ignoreRegExpLiterals: true,
          ignoreComments: true,
        },
      ],
      'no-lonely-if': 'error',
      'no-else-return': 'error',
      'no-useless-return': 'error',
      'no-dupe-else-if': 'error',
      'no-unreachable-loop': 'error',
      'no-constant-binary-expression': 'error',
      'no-self-compare': 'error',
      'no-var': 'error',
      'no-param-reassign': 'error',
    },
  },
  {
    files: ['backend/src/**/*.ts', 'frontend/src/**/*.ts', 'frontend/src/**/*.tsx', 'shared/src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.test.tsx'],
    plugins: { 'issue-resolver': localPlugin },
    rules: {
      'issue-resolver/closed-set-literals': 'error',
      'issue-resolver/untrusted-json-cast': 'warn',
    },
  },
);