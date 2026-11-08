// Drives index.html in headless Chrome over the DevTools protocol.
// Requires a static server on 127.0.0.1:8790 serving this directory (python3 -m http.server 8790 --bind 127.0.0.1).
// node test/browser.js
'use strict';
const { spawn } = require('child_process');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8790/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=9335', '--window-size=1100,800',
    '--user-data-dir=' + require('fs').mkdtempSync(require('os').tmpdir() + '/chrome-prof-'), BASE], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 50; i++) {
    try { targets = await (await fetch('http://127.0.0.1:9335/json')).json(); break; } catch (e) { await sleep(200); }
  }
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    targets = await (await fetch('http://127.0.0.1:9335/json')).json();
    page = targets.find((t) => t.type === 'page' && t.url.startsWith(BASE.split('?')[0]));
    if (!page) await sleep(200);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const pending = new Map(); const logs = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method === 'Runtime.consoleAPICalled') logs.push(msg.params.args.map((a) => a.value).join(' '));
    if (msg.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.result.value;
  await send('Runtime.enable'); await send('Page.enable');

  async function load(url) {
    const r = await send('Page.navigate', { url });
    if (r.result && r.result.errorText) throw new Error('navigate failed: ' + r.result.errorText);
    for (let i = 0; i < 50; i++) {
      await sleep(200);
      if (await evaluate(`document.readyState === 'complete' && document.querySelectorAll('.sq').length === 64`)) break;
    }
    await sleep(300);
  }
  async function center(sq) {
    return evaluate(`(() => { const r = document.querySelector('[data-sq="${sq}"]').getBoundingClientRect(); return [r.x + r.width/2, r.y + r.height/2]; })()`);
  }
  async function click(sq) {
    const [x, y] = await center(sq);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(100);
  }
  async function dragMove(a, b) {
    const [x1, y1] = await center(a), [x2, y2] = await center(b);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: (x1 + x2) / 2, y: (y1 + y2) / 2, button: 'left' });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x2, y: y2, button: 'left' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
    await sleep(100);
  }
  const movesText = () => evaluate(`[...document.querySelectorAll('#moves .mv')].map(e => e.textContent).join(' ')`);
  const status = () => evaluate(`document.getElementById('status').textContent`);
  let fails = 0;
  const check = (name, cond, extra) => { console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!cond) fails++; };

  // 1. play: click-click e2e4, wait for engine reply, then drag g1f3
  await load(BASE);
  console.log('page:', await evaluate(`document.title + ' ' + document.querySelectorAll('.sq').length`), logs.join(' | '));
  await evaluate(`document.getElementById('think').value = '250'`);
  await click('e2'); await click('e4');
  await sleep(1500);
  let mv = await movesText();
  check('click move + engine reply', mv.split(' ').length === 2 && mv.startsWith('e4'), mv);
  await dragMove('g1', 'f3');
  await sleep(1500);
  mv = await movesText();
  check('drag move + engine reply', mv.split(' ').length === 4 && mv.split(' ')[2] === 'Nf3', mv);
  check('engine info shown', (await evaluate(`document.getElementById('info').textContent`)).includes('depth'));
  // undo
  await evaluate(`document.getElementById('undo').click()`); await sleep(200);
  mv = await movesText();
  check('undo takes back a full move', mv.split(' ').length === 2, mv);
  // illegal move ignored
  await click('e1'); await click('e3'); await sleep(300);
  check('illegal move ignored', (await movesText()) === mv);
  // play as black: engine moves first
  await evaluate(`document.getElementById('newBlack').click()`); await sleep(1500);
  mv = await movesText();
  check('engine opens when human is black', mv.split(' ').length === 1, mv);
  await send('Page.captureScreenshot').then((r) => require('fs').writeFileSync('/tmp/aaw/shot_play.png', Buffer.from(r.result.data, 'base64')));

  // 2. promotion dialog
  await load(BASE + '?pgn=' + encodeURIComponent('[FEN "8/P6k/8/8/8/8/8/K7 w - - 0 1"]'));
  await evaluate(`document.getElementById('rTakeover').click()`); await sleep(300);
  await click('a7'); await click('a8'); await sleep(200);
  check('promotion dialog shown', await evaluate(`getComputedStyle(document.getElementById('promo')).display === 'flex'`));
  await evaluate(`document.querySelectorAll('#promoChoices button')[3].click()`); await sleep(1200);
  mv = await movesText();
  check('underpromotion to knight', mv.startsWith('a8=N'), mv);

  // 3. replay with a full game incl. check, castling, result
  const pgn = '1.e4 e5 2.Bc4 Nc6 3.Qh5 Nf6?? 4.Qxf7# 1-0';
  await load(BASE + '?pgn=' + encodeURIComponent(pgn));
  await evaluate(`document.getElementById('rLast').click()`); await sleep(200);
  check('replay parses game', (await movesText()) === 'e4 e5 Bc4 Nc6 Qh5 Nf6 Qxf7#', await movesText());
  check('replay shows mate', (await status()).includes('Checkmate'), await status());
  await evaluate(`document.getElementById('rFirst').click()`); await sleep(100);
  check('replay first', (await status()).startsWith('0/7'), await status());
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(100);
  check('arrow key steps', (await status()).startsWith('1/7'), await status());
  // raw, unencoded-ish URL with + signs and move numbers like "1..."
  await load(BASE + '?pgn=1.d4 d5 2.c4 dxc4 3.e3 b5 4.a4 c6 5.axb5 cxb5 6.Qf3');
  await evaluate(`document.getElementById('rLast').click()`); await sleep(100);
  check('replay plain URL', (await movesText()).endsWith('Qf3'), await movesText());
  await load(BASE + '?pgn=' + encodeURIComponent('1. e4 {best by test} e5 (1... c5 2. Nf3) 2. Nf3 $1 Nc6 3. Bb5 a6 4. O-O *'));
  await evaluate(`document.getElementById('rLast').click()`); await sleep(100);
  check('replay with comments/variations', (await movesText()) === 'e4 e5 Nf3 Nc6 Bb5 a6 O-O', await movesText());
  await send('Page.captureScreenshot').then((r) => require('fs').writeFileSync('/tmp/aaw/shot_replay.png', Buffer.from(r.result.data, 'base64')));

  check('no page errors', !logs.some((l) => l.startsWith('EXCEPTION')), logs.join('\n'));
  ws.close(); chrome.kill();
  console.log(fails ? fails + ' FAILURES' : 'all browser tests passed');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); try { require('child_process').execSync('pkill -f chrome-prof'); } catch (x) {} process.exit(1); });
