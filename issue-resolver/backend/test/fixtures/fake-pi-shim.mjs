// Фейковый pi RPC (JSONL stdin → JSONL stdout) для интеграционных тестов
// реального RpcPiRunner. Режим передаётся первым аргументом:
//   normal  — читает prompt, отвечает agent_settled{aborted:false} (+stats)
//   aborted — читает prompt, отвечает agent_settled{aborted:true}
//   crash   — падает exit(1) без agent_settled
//   hang    — молчит, держит stdin/stdout открытыми
import process from 'node:process';

const mode = process.argv[2] ?? 'normal';

const write = (obj) => {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
};

const STATS = {
  sessionId: 'shim-session',
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 2,
  tokens: { input: 7, output: 3, cacheRead: 1, cacheWrite: 0, total: 11 },
  cost: 0.01,
  contextUsage: { tokens: 11, contextWindow: 1000, percent: 1 },
};

if (mode === 'hang') {
  process.stdin.resume();
  setInterval(() => {}, 1 << 30);
} else if (mode === 'crash') {
  process.stdout.end();
  process.stderr.write('shim crash\n');
  process.exit(1);
} else {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      let command;
      try {
        command = JSON.parse(line);
      } catch {
        continue;
      }
      if (command.type === 'prompt') {
        write({ type: 'agent_settled', aborted: mode === 'aborted' });
      } else if (command.type === 'get_session_stats') {
        write({
          type: 'response',
          command: 'get_session_stats',
          success: true,
          data: STATS,
        });
      } else if (command.type === 'get_state') {
        write({
          type: 'response',
          command: 'get_state',
          success: true,
          data: { model: { id: 'shim-model', name: 'Shim', provider: 'shim' } },
        });
      }
    }
  });
  process.stdin.resume();
}