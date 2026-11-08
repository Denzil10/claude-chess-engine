"""Stockfish ladder for the Claude-built engine.

Rungs: Stockfish UCI_LimitStrength at rising UCI_Elo, then full strength.
Each rung is 2 games (engine White, then Black), 1 s per move each.
The engine climbs if it scores >= 1 point at a rung; otherwise it is out.
Usage: venv/bin/python ladder.py <engine dir> <out dir> [movetime]
"""
import json, sys, time, pathlib
import chess, chess.engine, chess.pgn

eng_dir = pathlib.Path(sys.argv[1]).resolve(); out = pathlib.Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
mt = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
RUNGS = [1320, 1600, 2000, 2400, 2600, 2800, 3000, 3190, None]  # None = no strength limit


def play(white_cmd, black_cmd, white_name, black_name, sf_elo, game_no):
    sf_opts = {"Threads": 1, "Hash": 64}
    if sf_elo:
        sf_opts.update({"UCI_LimitStrength": True, "UCI_Elo": sf_elo})
    engines = {}
    for color, cmd, name in ((chess.WHITE, white_cmd, white_name), (chess.BLACK, black_cmd, black_name)):
        e = chess.engine.SimpleEngine.popen_uci(cmd, cwd=str(eng_dir) if name == "Claude" else None)
        if name == "Stockfish":
            e.configure(sf_opts)
        engines[color] = e
    board = chess.Board(); moves_t = []; illegal = None
    try:
        while not board.is_game_over(claim_draw=True) and board.ply() < 400:
            t0 = time.time()
            try:
                r = engines[board.turn].play(board, chess.engine.Limit(time=mt))
            except (chess.engine.EngineError, chess.engine.EngineTerminatedError) as ex:
                illegal = f"{'White' if board.turn else 'Black'} engine error: {ex}"; break
            moves_t.append(round(time.time() - t0, 2))
            if r.move is None or r.move not in board.legal_moves:
                illegal = f"{'White' if board.turn else 'Black'} illegal move {r.move}"; break
            board.push(r.move)
    finally:
        for e in engines.values():
            try: e.quit()
            except Exception: pass
    if illegal:
        result = "0-1" if "White" in illegal else "1-0"
    elif board.ply() >= 400 and not board.is_game_over(claim_draw=True):
        result = "1/2-1/2"
    else:
        result = board.result(claim_draw=True)
    g = chess.pgn.Game.from_board(board)
    g.headers.update({"White": white_name, "Black": black_name, "Result": result,
                      "Event": f"Ladder rung {sf_elo or 'full'}", "Round": str(game_no)})
    reason = illegal or (board.outcome(claim_draw=True).termination.name if board.outcome(claim_draw=True) else "ply cap")
    g.headers["Termination"] = reason
    return g, result, reason, board.ply(), max(moves_t or [0])


claude_cmd = ["node", str(eng_dir / "uci.js")]
log = []
for elo in RUNGS:
    score = 0.0
    for n, claude_white in enumerate((True, False), 1):
        w, b = (claude_cmd, "stockfish") if claude_white else ("stockfish", claude_cmd)
        wn, bn = ("Claude", "Stockfish") if claude_white else ("Stockfish", "Claude")
        g, res, reason, plies, slowest = play(w, b, wn, bn, elo, n)
        pts = {"1-0": 1.0, "0-1": 0.0, "1/2-1/2": 0.5}[res]
        pts = pts if claude_white else 1 - pts
        score += pts
        name = f"rung{elo or 'full'}-g{n}"
        (out / f"{name}.pgn").write_text(str(g) + "\n")
        row = {"rung": elo or "full", "game": n, "claude": "white" if claude_white else "black",
               "result": res, "claude_points": pts, "reason": reason, "plies": plies, "slowest_move_s": slowest,
               "uci": " ".join(m.uci() for m in g.mainline_moves())}
        log.append(row); print(json.dumps({k: v for k, v in row.items() if k != "uci"}), flush=True)
        (out / "ladder.json").write_text(json.dumps(log, indent=1))
    print(f"rung {elo or 'full'}: Claude scored {score}/2", flush=True)
    if score < 1:
        break
