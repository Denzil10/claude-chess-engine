#!/usr/bin/env node
// uci.js - UCI front end for engine.js.
// The search runs in a worker thread so "stop", "isready" and "quit" are handled
// while the engine is thinking. Usage: node uci.js
'use strict';
const path = require('path');
const { Worker } = require('worker_threads');

const NAME = 'JSChess 1.0';
const AUTHOR = 'Claude';

const workerCode = `
const { parentPort, workerData } = require('worker_threads');
const E = require(workerData.enginePath);
E.setStopSignal(new Int32Array(workerData.stop));
parentPort.on('message', (msg) => {
  try {
    if (msg.cmd === 'position') E.setPosition(msg.fen, msg.moves);
    else if (msg.cmd === 'newgame') E.newGame();
    else if (msg.cmd === 'hash') E.setHash(msg.mb);
    else if (msg.cmd === 'go') {
      const r = E.search(Object.assign({}, msg.opts, { onInfo: (i) => parentPort.postMessage({ type: 'info', info: i }) }));
      parentPort.postMessage({ type: 'bestmove', result: r });
    } else if (msg.cmd === 'eval') parentPort.postMessage({ type: 'text', text: 'eval ' + E.evaluate() + ' fen ' + E.getFen() });
    else if (msg.cmd === 'perft') {
      const t = Date.now(); const n = E.perft(msg.depth);
      parentPort.postMessage({ type: 'text', text: 'nodes ' + n + ' time ' + (Date.now() - t) });
    }
  } catch (err) {
    parentPort.postMessage({ type: 'text', text: 'info string error ' + err.message });
    if (msg.cmd === 'go') parentPort.postMessage({ type: 'bestmove', result: { bestMove: null } });
  }
});
`;

const stopBuf = new SharedArrayBuffer(4);
const stop = new Int32Array(stopBuf);
const worker = new Worker(workerCode, {
  eval: true,
  workerData: { enginePath: path.join(__dirname, 'engine.js'), stop: stopBuf },
});

let searching = false, infinite = false, heldBest = null, quitAfter = false, overhead = null;

function out(s) { process.stdout.write(s + '\n'); }

function formatInfo(i) {
  const score = i.mate != null ? 'mate ' + i.mate : 'cp ' + i.cp;
  return `info depth ${i.depth} seldepth ${i.seldepth} score ${score} nodes ${i.nodes} nps ${i.nps} time ${i.time} pv ${i.pv.join(' ')}`;
}

function emitBest(r) {
  out('bestmove ' + (r.bestMove || '0000') + (r.ponder ? ' ponder ' + r.ponder : ''));
  searching = false;
  if (quitAfter) process.exit(0);
}

worker.on('message', (msg) => {
  if (msg.type === 'info') out(formatInfo(msg.info));
  else if (msg.type === 'text') out(msg.text);
  else if (msg.type === 'bestmove') {
    if (infinite && !Atomics.load(stop, 0)) heldBest = msg.result;  // UCI: wait for "stop"
    else emitBest(msg.result);
  }
});
worker.on('error', (e) => { out('info string worker error ' + e.message); process.exit(1); });

function parsePosition(tokens) {
  let i = 1, fen = 'startpos';
  if (tokens[i] === 'startpos') i++;
  else if (tokens[i] === 'fen') {
    const parts = [];
    i++;
    while (i < tokens.length && tokens[i] !== 'moves') parts.push(tokens[i++]);
    fen = parts.join(' ');
  }
  const moves = [];
  if (tokens[i] === 'moves') for (i++; i < tokens.length; i++) moves.push(tokens[i]);
  worker.postMessage({ cmd: 'position', fen, moves });
}

function parseGo(tokens) {
  const opts = {};
  const num = ['wtime', 'btime', 'winc', 'binc', 'movestogo', 'depth', 'nodes', 'movetime', 'mate'];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (num.includes(t)) opts[t] = parseInt(tokens[++i], 10);
    else if (t === 'infinite' || t === 'ponder') opts.infinite = true;
  }
  if (opts.mate && !opts.depth) opts.depth = opts.mate * 2 + 1;
  if (overhead != null) opts.overhead = overhead;
  infinite = !!opts.infinite;
  heldBest = null;
  Atomics.store(stop, 0, 0);
  searching = true;
  worker.postMessage({ cmd: 'go', opts });
}

function doStop() {
  if (!searching) return;
  Atomics.store(stop, 0, 1);
  if (heldBest) { const r = heldBest; heldBest = null; emitBest(r); }
}

function handle(line) {
  const tokens = line.trim().split(/\s+/);
  const cmd = tokens[0];
  switch (cmd) {
    case 'uci':
      out('id name ' + NAME);
      out('id author ' + AUTHOR);
      out('option name Hash type spin default 64 min 1 max 1024');
      out('option name Move Overhead type spin default 30 min 0 max 5000');
      out('uciok');
      break;
    case 'isready': out('readyok'); break;
    case 'ucinewgame': worker.postMessage({ cmd: 'newgame' }); break;
    case 'setoption': {
      const m = line.match(/name\s+(.+?)\s+value\s+(\S+)/i);
      if (m) {
        const name = m[1].toLowerCase();
        if (name === 'hash') worker.postMessage({ cmd: 'hash', mb: Math.max(1, Math.min(1024, +m[2])) });
        else if (name === 'move overhead') overhead = Math.max(0, +m[2]);
      }
      break;
    }
    case 'position': parsePosition(tokens); break;
    case 'go': parseGo(tokens); break;
    case 'stop': doStop(); break;
    case 'ponderhit': infinite = false; doStop(); break;
    case 'quit': process.exit(0); break;
    case 'eval': worker.postMessage({ cmd: 'eval' }); break;
    case 'perft': worker.postMessage({ cmd: 'perft', depth: +tokens[1] || 1 }); break;
    case 'd': worker.postMessage({ cmd: 'eval' }); break;
    default: if (cmd) out('info string unknown command ' + cmd);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, '');
    buf = buf.slice(idx + 1);
    handle(line);
  }
});
process.stdin.on('end', () => {
  if (buf.trim()) handle(buf);
  if (searching) { quitAfter = true; if (infinite) doStop(); }
  else process.exit(0);
});
