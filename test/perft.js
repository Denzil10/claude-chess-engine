// Perft test against known node counts. Usage: node test/perft.js [maxNodes]
const E = require('../engine.js');
const LIMIT = +(process.argv[2] || 2e7);
const tests = [
  ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', [20, 400, 8902, 197281, 4865609, 119060324]],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862, 4085603, 193690690]],
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238, 674624, 11030083, 178633661]],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467, 422333, 15833292]],
  ['r2q1rk1/pP1p2pp/Q4n2/bbp1p3/Np6/1B3NBn/pPPP1PPP/R3K2R b KQ - 0 1', [6, 264, 9467, 422333, 15833292]],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379, 2103487, 89941194]],
  ['n1n5/PPPk4/8/8/8/8/4Kppp/5N1N b - - 0 1', [24, 496, 9483, 182838, 3605103, 71179139]],
  ['4k3/8/8/8/8/8/8/4K2R w K - 0 1', [15, 66, 1197, 7059, 133987, 764643]],
  ['8/P1k5/K7/8/8/8/8/8 w - - 0 1', [6, 27, 273, 1329, 18135, 92683]],
];
let fail = 0, totalNodes = 0;
const t0 = Date.now();
for (const [fen, counts] of tests) {
  for (let d = 1; d <= counts.length; d++) {
    if (counts[d - 1] === null) continue;
    if (counts[d - 1] > LIMIT) break;
    E.setFen(fen);
    const n = E.perft(d);
    totalNodes += n;
    const ok = n === counts[d - 1];
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} d${d} ${String(n).padStart(10)} expected ${counts[d - 1]}  ${fen}`);
    if (E.getFen().split(' ').slice(0, 4).join(' ') !== fen.split(' ').slice(0, 4).join(' ')) { console.log('FAIL state not restored'); fail++; }
  }
}
const ms = Date.now() - t0;
console.log(`${fail ? fail + ' FAILURES' : 'all perft tests passed'}; ${totalNodes} nodes in ${ms} ms (${Math.round(totalNodes / ms)}k nps)`);
process.exit(fail ? 1 : 0);
