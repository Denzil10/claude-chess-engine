#!/usr/bin/env node
// Engine-vs-engine match runner (UCI).
// node tools/match.js --e1 "node uci.js" --e2 "node uci.js" [--games 20] [--tc 10+0.1 | --movetime 100]
//   [--concurrency 4] [--pgn out.pgn] [--e1opt "UCI_LimitStrength=true,UCI_Elo=1500"] [--e2opt ...]
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const GAMES = +(args.games || 20);
const CONC = +(args.concurrency || 4);
const MOVETIME = args.movetime ? +args.movetime : 0;
const [TC_BASE, TC_INC] = (args.tc || '10+0.1').split('+').map(Number);
const PGN = args.pgn || null;
const n1 = args.n1 || 'engine1', n2 = args.n2 || 'engine2';

// a small, balanced opening book (UCI moves); each opening is played with both colours
const OPENINGS = [
  'e2e4 e7e5 g1f3 b8c6 f1b5 a7a6', 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4', 'd2d4 d7d5 c2c4 e7e6 b1c3 g8f6',
  'd2d4 g8f6 c2c4 g7g6 b1c3 f8g7', 'e2e4 e7e6 d2d4 d7d5 b1c3 f8b4', 'e2e4 c7c6 d2d4 d7d5 e4e5 c8f5',
  'c2c4 e7e5 b1c3 g8f6 g1f3 b8c6', 'g1f3 d7d5 g2g3 g8f6 f1g2 c7c6', 'e2e4 e7e5 g1f3 b8c6 f1c4 f8c5',
  'd2d4 g8f6 c2c4 e7e6 g1f3 b7b6', 'e2e4 c7c5 b1c3 b8c6 g2g3 g7g6', 'd2d4 d7d5 g1f3 g8f6 c1f4 c7c5',
  'e2e4 d7d6 d2d4 g8f6 b1c3 g7g6', 'c2c4 c7c5 g1f3 g8f6 b1c3 b8c6', 'e2e4 e7e5 g1f3 g8f6 f3e5 d7d6',
  'd2d4 f7f5 g2g3 g8f6 f1g2 e7e6', 'e2e4 c7c5 g1f3 e7e6 d2d4 c5d4', 'd2d4 d7d5 c2c4 c7c6 g1f3 g8f6',
  'e2e4 b8c6 d2d4 d7d5 b1c3 d5e4', 'b2b3 e7e5 c1b2 b8c6 e2e3 g8f6',
];

class UciEngine {
  constructor(cmd, opts) {
    this.proc = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = ''; this.waiters = []; this.lines = [];
    this.proc.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        this.lastInfo = line.startsWith('info depth') ? line : this.lastInfo;
        for (let k = 0; k < this.waiters.length; k++) {
          if (this.waiters[k].test(line)) { const w = this.waiters.splice(k, 1)[0]; w.resolve(line); break; }
        }
      }
    });
    this.opts = opts || [];
  }
  send(s) { this.proc.stdin.write(s + '\n'); }
  wait(re) { return new Promise((resolve) => this.waiters.push({ test: (l) => re.test(l), resolve })); }
  async init() {
    this.send('uci'); await this.wait(/^uciok/);
    for (const o of this.opts) { const [k, v] = o.split('='); this.send(`setoption name ${k} value ${v}`); }
    this.send('isready'); await this.wait(/^readyok/);
  }
  async newGame() { this.send('ucinewgame'); this.send('isready'); await this.wait(/^readyok/); }
  quit() { try { this.send('quit'); } catch (e) {} setTimeout(() => this.proc.kill(), 500); }
}

function status(moves) {
  E.setPosition('startpos', moves);
  return E.gameStatus();
}

async function playGame(white, black, opening, wName, bName, round) {
  const moves = opening.split(' ');
  const sans = [];
  E.setPosition('startpos', []);
  for (const m of moves) sans.push(E.playMove(m).san);
  await white.newGame(); await black.newGame();
  let wt = TC_BASE * 1000, bt = TC_BASE * 1000;
  let result = null, reason = '';
  while (true) {
    const st = status(moves);
    const stm = moves.length % 2 === 0 ? 'w' : 'b';
    if (st) {
      if (st === 'checkmate') { result = stm === 'w' ? '0-1' : '1-0'; reason = 'checkmate'; }
      else { result = '1/2-1/2'; reason = st; }
      break;
    }
    if (moves.length >= 600) { result = '1/2-1/2'; reason = 'move limit'; break; }
    const eng = stm === 'w' ? white : black;
    eng.send('position startpos moves ' + moves.join(' '));
    const t0 = Date.now();
    if (MOVETIME) eng.send('go movetime ' + MOVETIME);
    else eng.send(`go wtime ${Math.max(1, Math.round(wt))} btime ${Math.max(1, Math.round(bt))} winc ${TC_INC * 1000} binc ${TC_INC * 1000}`);
    const line = await eng.wait(/^bestmove/);
    const used = Date.now() - t0;
    if (!MOVETIME) {
      if (stm === 'w') { wt -= used; if (wt < 0) { result = '0-1'; reason = 'white time forfeit'; break; } wt += TC_INC * 1000; }
      else { bt -= used; if (bt < 0) { result = '1-0'; reason = 'black time forfeit'; break; } bt += TC_INC * 1000; }
    }
    const mv = line.split(/\s+/)[1];
    E.setPosition('startpos', moves);
    const played = E.playMove(mv);
    if (!played) { result = stm === 'w' ? '0-1' : '1-0'; reason = `illegal move ${mv} by ${stm}`; break; }
    moves.push(played.uci); sans.push(played.san);
  }
  let pgn = `[Event "match"]\n[Round "${round}"]\n[White "${wName}"]\n[Black "${bName}"]\n[Result "${result}"]\n[Termination "${reason}"]\n\n`;
  for (let i = 0; i < sans.length; i++) pgn += (i % 2 === 0 ? (i / 2 + 1) + '. ' : '') + sans[i] + ' ';
  pgn += result + '\n\n';
  return { result, reason, pgn, plies: moves.length };
}

async function main() {
  const o1 = args.e1opt ? args.e1opt.split(',') : [], o2 = args.e2opt ? args.e2opt.split(',') : [];
  let w = 0, l = 0, d = 0, next = 0;
  const pgnOut = [];
  async function workerLoop() {
    const a = new UciEngine(args.e1 || 'node ' + path.join(__dirname, '..', 'uci.js'), o1);
    const b = new UciEngine(args.e2 || 'node ' + path.join(__dirname, '..', 'uci.js'), o2);
    await a.init(); await b.init();
    while (next < GAMES) {
      const g = next++;
      const opening = OPENINGS[(g >> 1) % OPENINGS.length];
      const e1White = g % 2 === 0;
      const r = e1White ? await playGame(a, b, opening, n1, n2, g + 1) : await playGame(b, a, opening, n2, n1, g + 1);
      const s1 = r.result === '1/2-1/2' ? 0.5 : ((r.result === '1-0') === e1White ? 1 : 0);
      if (s1 === 1) w++; else if (s1 === 0) l++; else d++;
      pgnOut.push(r.pgn);
      const n = w + l + d, score = (w + d / 2) / n;
      const elo = score <= 0 ? -999 : score >= 1 ? 999 : -400 * Math.log10(1 / score - 1);
      console.log(`game ${g + 1}: ${e1White ? n1 + ' (W)' : n1 + ' (B)'} ${r.result} ${r.reason} (${r.plies} plies)  |  ${n1} +${w} -${l} =${d}  score ${(score * 100).toFixed(1)}%  elo ${elo.toFixed(0)}`);
    }
    a.quit(); b.quit();
  }
  const ws = [];
  for (let i = 0; i < CONC; i++) ws.push(workerLoop());
  await Promise.all(ws);
  if (PGN) fs.writeFileSync(PGN, pgnOut.join(''));
  const n = w + l + d, score = (w + d / 2) / n;
  const elo = score <= 0 ? -999 : score >= 1 ? 999 : -400 * Math.log10(1 / score - 1);
  const se = Math.sqrt(score * (1 - score) / n);
  console.log(`FINAL ${n1} vs ${n2}: +${w} -${l} =${d}  score ${(score * 100).toFixed(1)}%  elo diff ${elo.toFixed(0)} (±${(se * 400 / Math.LN10 / Math.max(0.01, score * (1 - score)) * 1.96).toFixed(0)} approx 95%)`);
  process.exit(0);
}
main();
