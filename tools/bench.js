// Fixed-depth benchmark + small tactics check. node tools/bench.js [depth] [movetime]
const E = require('../engine.js');
const depth = +(process.argv[2] || 12), mt = +(process.argv[3] || 1000);
const BENCH = [
  E.START_FEN,
  'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
  'r1bq1rk1/pp2bppp/2n1pn2/3p4/2PP4/2N1PN2/PP2BPPP/R2QKB1R w KQ - 0 8',
  '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
  'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P3/2NP1N2/PPP1QPPP/R4RK1 w - - 0 10',
  '6k1/p4pp1/1p2p2p/8/2P5/1P3PP1/P5KP/3r4 w - - 0 30',
];
let nodes = 0, t = 0;
for (const f of BENCH) {
  E.newGame(); E.setPosition(f, []);
  const r = E.search({ depth });
  nodes += r.nodes; t += r.time;
}
console.log(`bench depth ${depth}: ${nodes} nodes ${t} ms ${Math.round(nodes / t)}k nps`);
const TACTICS = [
  ['2rr3k/pp3pp1/1nnqbN1p/3pN3/2pP4/2P3Q1/PPB4P/R4RK1 w - - 0 1', ['g3g6']],
  ['8/7p/5k2/5p2/p1p2P2/Pr1pPK2/1P1R3P/8 b - - 0 1', ['b3b2']],
  ['5rk1/1ppb3p/p1pb4/6q1/3P1p1r/2P1R2P/PP1BQ1P1/5RKN w - - 0 1', ['e3g3']],
  ['r1bq2rk/pp3pbp/2p1p1pQ/7P/3P4/2PB1N2/PP3PPR/2KR4 w - - 0 1', ['h6h7']],
  ['5k2/6pp/p1qN4/1p1p4/3P4/2PKP2Q/PP3r2/3R4 b - - 0 1', ['c6c4']],
  ['r1b1k2r/ppppnppp/2n2q2/2b5/3NP3/2P1B3/PP3PPP/RN1QKB1R w KQkq - 0 1', ['d4c6', 'd4f5']],
];
let ok = 0;
for (const [f, bm] of TACTICS) {
  E.newGame(); E.setPosition(f, []);
  const r = E.search({ movetime: mt });
  const good = bm.includes(r.bestMove);
  if (good) ok++;
  console.log(`${good ? 'ok  ' : 'MISS'} ${r.bestMove} (want ${bm.join('/')}) d${r.depth} score ${r.score}  ${f}`);
}
console.log(`tactics ${ok}/${TACTICS.length}`);
