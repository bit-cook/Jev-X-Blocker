// Local end-to-end harness for real-browser testing when both x.com and
// api.typesafe.ai are unreachable from this network.
//
//   GET  /home | /{user}/status/{id} | anything  -> mock X timeline DOM
//   POST /v1/systemone                           -> mock TypeSafe Jev API (CORS)
//
// The mock page replicates the DOM contract the adapter relies on:
// article[data-testid="tweet"], [data-testid="tweetText"],
// [data-testid="User-Name"], a[href*="/status/"].
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8788);

const HIDE_KEYWORDS = ['骚', '福利', '私密', '只进身体', '进群', '想约', '私聊', '加我', '完整版', 'DM for'];

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Mock X</title>
<style>body{font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;margin:0;padding:16px;background:#000;color:#e7e9ea}
article{border:1px solid #2f3336;border-radius:12px;padding:12px;margin:8px 0}
a{color:#1d9bf0;text-decoration:none}.name{font-weight:700;margin-top:6px}.text{margin-top:4px}</style></head>
<body><h1 id="route">/</h1><div id="feed"></div>
<script>
const HOME = [
  {id:'201', href:'/promo_bot/status/201', name:'引流机器人 @promo_bot', text:'只进身体不进生活🖤想约的私信，本人可视频验证'},
  {id:'202', href:'/welfare_daily/status/202', name:'每日福利社 @welfare_daily', text:'福利视频每日更新，点击主页链接进群观看，限时免费'},
  {id:'203', href:'/tech_fan/status/203', name:'科技爱好者 @tech_fan', text:'今天发布会的新品确实惊艳，屏幕和续航都升级了'}
];
const DETAIL_ROOT = {id:'123456789', href:'/someone/status/123456789', name:'只谈风月 @only_body', text:'只进身体不进生活🖤想约的私信'};
const DETAIL_REPLIES = [
  {id:'301', href:'/a/status/301', name:'普通网友 @a', text:'支持楼主，说得对'},
  {id:'302', href:'/b/status/302', name:'福利姬 @b', text:'比我好看的没我骚🍑比我骚的没我好看，想看更多私聊我'}
];
function article(t){
  const el=document.createElement('article'); el.setAttribute('data-testid','tweet');
  const a=document.createElement('a'); a.href=t.href; a.textContent='/status/'+t.id;
  const n=document.createElement('div'); n.setAttribute('data-testid','User-Name'); n.textContent=t.name;
  const p=document.createElement('div'); p.setAttribute('data-testid','tweetText'); p.textContent=t.text;
  el.append(a,n,p); return el;
}
function render(){
  const path=location.pathname;
  document.getElementById('route').textContent=path;
  const feed=document.getElementById('feed'); feed.replaceChildren();
  if (/\\/status\\//.test(path)) { feed.append(article(DETAIL_ROOT)); for (const r of DETAIL_REPLIES) feed.append(article(r)); }
  else { for (const t of HOME) feed.append(article(t)); }
}
render();
setInterval(()=>{ if(document.getElementById('route').textContent!==location.pathname) render(); },300);
</script></body></html>`;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = createServer((req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url.startsWith('/v1/systemone')) {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      let content = '';
      try { content = String((JSON.parse(body).state || {}).content || ''); } catch (_) {}
      const risky = HIDE_KEYWORDS.some((keyword) => content.includes(keyword));
      const answers = {};
      for (const id of ['sexual_content', 'sexual_solicitation', 'spam_behavior']) {
        answers[id] = { type: 'noul', noul: risky ? (id === 'sexual_content' ? 0.93 : id === 'sexual_solicitation' ? 0.9 : 0.2) : 0.06 };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ model: 'jev-mock', answers, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock x.com + TypeSafe listening on http://127.0.0.1:${PORT}`);
});
