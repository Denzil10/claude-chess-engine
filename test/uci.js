// UCI protocol tests for uci.js. node test/uci.js
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const E = require('../engine.js');

class Eng {
  constructor() {
    this.p = spawn('node', [path.join(__dirname, '..', 'uci.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = ''; this.lines = []; this.waiters = [];
    this.p.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const l = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        this.lines.push(l);
        this.waiters = this.waiters.filter((w) => { if (w.re.test(l)) { w.res(l); return false; } return true; });
      }
    });
    this.exited = new Promise((r) => this.p.on('exit', (code) => r(code)));
  }
  send(s) { this.p.stdin.write(s + '\n'); }
  wait(re, ms = 15000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for ' + re)), ms);
      this.waiters.push({ re, res: (l) => { clearTimeout(t); res(l); } });
    });
  }
}

let fails = 0;
function check(name, cond, extra) { console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? '  [' + extra + ']' : '')); if (!cond) fails++; }
function legalIn(fen, moves, best) { E.setPosition(fen, moves); return E.legalMoves().some((m) => m.uci === best); }

(async () => {
  const e = new Eng();
  e.send('uci');
  await e.wait(/^uciok/);
  check('uci -> id name', e.lines.some((l) => l.startsWith('id name')));
  check('uci -> id author', e.lines.some((l) => l.startsWith('id author')));
  e.send('setoption name Hash value 32');
  e.send('isready'); await e.wait(/^readyok/); check('isready -> readyok', true);
  e.send('ucinewgame');

  // go movetime: timing + legality
  for (const mt of [100, 500, 2000]) {
    e.send('position startpos moves e2e4 c7c5 g1f3');
    const t0 = Date.now(); e.send('go movetime ' + mt);
    const l = await e.wait(/^bestmove/);
    const dt = Date.now() - t0, best = l.split(' ')[1];
    check(`go movetime ${mt} returns in time`, dt <= mt + 100 && dt >= mt * 0.5, dt + 'ms');
    check(`go movetime ${mt} bestmove legal`, legalIn('startpos', ['e2e4', 'c7c5', 'g1f3'], best), l);
  }
  check('info lines have depth/score/pv', e.lines.some((l) => /^info depth \d+ seldepth \d+ score (cp|mate) -?\d+ nodes \d+ nps \d+ time \d+ pv /.test(l)));

  // go depth
  e.send('position fen r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3');
  e.send('go depth 6');
  let l = await e.wait(/^bestmove/);
  const depthLines = e.lines.filter((x) => x.startsWith('info depth'));
  check('go depth 6 stops at depth 6', /^info depth 6 /.test(depthLines[depthLines.length - 1]), depthLines[depthLines.length - 1].slice(0, 30));

  // go infinite + isready during search + stop
  e.send('position startpos');
  e.send('go infinite');
  await new Promise((r) => setTimeout(r, 500));
  e.send('isready');
  const t1 = Date.now();
  await e.wait(/^readyok/);
  check('isready answered during search', Date.now() - t1 < 200, (Date.now() - t1) + 'ms');
  const before = e.lines.filter((x) => x.startsWith('bestmove')).length;
  await new Promise((r) => setTimeout(r, 300));
  check('no bestmove before stop in infinite mode', e.lines.filter((x) => x.startsWith('bestmove')).length === before);
  const t2 = Date.now(); e.send('stop');
  l = await e.wait(/^bestmove/);
  check('stop returns bestmove promptly', Date.now() - t2 < 200, (Date.now() - t2) + 'ms');

  // go infinite on a forced mate: search ends early but must still wait for stop
  e.send('position fen 6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1');
  e.send('go infinite');
  await new Promise((r) => setTimeout(r, 400));
  const n0 = e.lines.filter((x) => x.startsWith('bestmove')).length;
  e.send('stop');
  l = await e.wait(/^bestmove/);
  check('mate-in-1 found', l.startsWith('bestmove d1d8'), l);
  check('infinite waits for stop even when finished', n0 === e.lines.filter((x) => x.startsWith('bestmove')).length - 1);
  check('mate score reported', e.lines.some((x) => / score mate 1 /.test(x)));

  // clock-based go
  e.send('position startpos moves d2d4 d7d5');
  const t3 = Date.now();
  e.send('go wtime 3000 btime 3000 winc 0 binc 0');
  l = await e.wait(/^bestmove/);
  check('go wtime/btime uses a sane slice of time', Date.now() - t3 < 1000, (Date.now() - t3) + 'ms');
  e.send('position startpos moves d2d4 d7d5');
  const t4 = Date.now();
  e.send('go wtime 100 btime 100 winc 0 binc 0');
  l = await e.wait(/^bestmove/);
  check('go with 100ms on the clock does not flag', Date.now() - t4 < 90, (Date.now() - t4) + 'ms');
  e.send('go movestogo 1 wtime 2000 btime 2000');
  l = await e.wait(/^bestmove/);
  check('movestogo accepted', /^bestmove \S{4}/.test(l));

  // ep / castling / promotion through position command
  e.send('position fen rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3 moves e5f6');
  e.send('go depth 4'); l = await e.wait(/^bestmove/);
  check('en passant in position moves', legalIn('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3', ['e5f6'], l.split(' ')[1]), l);
  e.send('position fen 8/P6k/8/8/8/8/8/K7 w - - 0 1');
  e.send('go depth 6'); l = await e.wait(/^bestmove/);
  check('promotion move output', l.startsWith('bestmove a7a8q'), l);
  e.send('position fen r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1 moves e1g1 e8c8');
  e.send('go depth 3'); l = await e.wait(/^bestmove/);
  check('castling in position moves', legalIn('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', ['e1g1', 'e8c8'], l.split(' ')[1]), l);

  // no legal moves
  e.send('position fen 7k/6Q1/6K1/8/8/8/8/8 b - - 0 1');
  e.send('go movetime 100'); l = await e.wait(/^bestmove/);
  check('checkmated side returns bestmove 0000', l.trim() === 'bestmove 0000', l);

  // long game history (repetition bookkeeping)
  const moves = [];
  for (let i = 0; i < 60; i++) moves.push(...['g1f3', 'g8f6', 'f3g1', 'f6g8']);
  e.send('position startpos moves ' + moves.join(' '));
  e.send('go movetime 100'); l = await e.wait(/^bestmove/);
  check('240-ply history accepted', /^bestmove \S{4}/.test(l), l);

  // unknown command does not crash; quit exits
  e.send('foobar');
  e.send('isready'); await e.wait(/^readyok/);
  e.send('quit');
  const code = await Promise.race([e.exited, new Promise((r) => setTimeout(() => r('timeout'), 2000))]);
  check('quit exits', code === 0, String(code));

  // piped input with EOF while searching still produces bestmove
  const p2 = spawn('node', [path.join(__dirname, '..', 'uci.js')]);
  let out2 = '';
  p2.stdout.on('data', (d) => (out2 += d));
  p2.stdin.end('uci\nposition startpos\ngo movetime 300\n');
  await new Promise((r) => p2.on('exit', r));
  check('EOF after go still answers', /bestmove \S{4}/.test(out2));

  console.log(fails ? fails + ' FAILURES' : 'all UCI tests passed');
  process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
