// Mock agent that speaks Claude Code stream-json over stdout. Used for local
// end-to-end tests when the real Claude Code CLI is unavailable.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

out({ type: 'system', subtype: 'init', session_id: 'demo-session', model: 'mock-agent', tools: ['Bash'] });
await sleep(50);
out({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'text', text: '我会运行测试并报告结果。' },
      { type: 'tool_use', id: 'tc_1', name: 'Bash', input: { command: 'npm test' } },
    ],
  },
});
await sleep(50);
out({
  type: 'control_request',
  request_id: 'req_demo_1',
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' } },
});
await sleep(300);
out({ type: 'result', subtype: 'success', result: '全部测试通过（mock）', usage: { input_tokens: 10, output_tokens: 5 } });

process.stdin.on('data', (chunk) => {
  const text = chunk.toString('utf8');
  for (const line of text.split(/\n/)) {
    if (!line) continue;
    let parsed = null;
    try { parsed = JSON.parse(line); } catch { parsed = null; }
    if (parsed?.type === 'user') {
      out({ type: 'user', message: { role: 'user', content: parsed.message?.content || '' } });
    }
  }
});

// Deterministic exit: the real bridge stops the process; the mock must not
// hold the event loop open forever in tests.
const lingerMs = Number(process.env.DEMO_LINGER_MS || 800);
setTimeout(() => process.exit(0), lingerMs);
