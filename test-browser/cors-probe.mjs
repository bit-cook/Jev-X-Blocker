// CORS probe: does the API allow browser (chrome-extension origin) calls?
// A 401/400 response that still carries Access-Control-Allow-Origin proves
// CORS is enabled — which is what an MV3 service worker fetch needs.
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const TARGETS = [
  ['OpenAI', 'https://api.openai.com/v1/chat/completions', 'POST'],
  ['Anthropic', 'https://api.anthropic.com/v1/messages', 'POST'],
  ['Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent', 'POST'],
  ['xAI Grok', 'https://api.x.ai/v1/chat/completions', 'POST'],
  ['DeepSeek', 'https://api.deepseek.com/chat/completions', 'POST'],
  ['Moonshot Kimi', 'https://api.moonshot.cn/v1/chat/completions', 'POST'],
  ['智谱 GLM', 'https://open.bigmodel.cn/api/paas/v4/chat/completions', 'POST'],
  ['阿里 DashScope', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', 'POST'],
  ['阿里 百炼', 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', 'POST'],
  ['火山方舟 豆包', 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', 'POST'],
  ['MiniMax', 'https://api.minimax.chat/v1/text/chatcompletion_v2', 'POST'],
  ['百度千帆', 'https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop/chat/completions', 'POST'],
  ['硅基流动', 'https://api.siliconflow.cn/v1/chat/completions', 'POST'],
  ['OpenRouter', 'https://openrouter.ai/api/v1/chat/completions', 'POST'],
  ['TypeSafe Jev', 'https://api.typesafe.ai/v1/systemone', 'POST']
];

async function probe(name, url, method) {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Origin: ORIGIN,
        'Access-Control-Request-Method': method,
        'Content-Type': 'application/json',
        Authorization: 'Bearer probe-invalid-key'
      },
      body: method === 'POST' ? '{"model":"probe","messages":[]}' : undefined,
      signal: AbortSignal.timeout(12000)
    });
    const allow = response.headers.get('access-control-allow-origin');
    const allowCreds = response.headers.get('access-control-allow-credentials');
    return { name, status: response.status, cors: allow || '(无)', creds: allowCreds || '-' };
  } catch (error) {
    return { name, status: 'ERR', cors: error.cause ? (error.cause.code || error.cause.message) : error.message, creds: '-' };
  }
}

const results = await Promise.all(TARGETS.map(([name, url, method]) => probe(name, url, method)));

console.log('API'.padEnd(18), 'HTTP'.padEnd(6), 'Access-Control-Allow-Origin'.padEnd(30), 'Credentials');
console.log('-'.repeat(86));
for (const r of results) {
  const browserOk = r.cors === '*' || r.cors === ORIGIN;
  console.log(
    r.name.padEnd(18),
    String(r.status).padEnd(6),
    (browserOk ? '✅ ' : '❌ ') + r.cors.slice(0, 26).padEnd(26),
    r.creds
  );
}
const usable = results.filter((r) => r.cors === '*' || r.cors === ORIGIN);
console.log(`\n可被浏览器/扩展直连: ${usable.length}/${results.length} -> ${usable.map((r) => r.name).join(', ') || '无'}`);
