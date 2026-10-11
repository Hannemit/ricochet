// Run with: node tests/solver.test.js
const assert = require('assert');
const path = require('path');
const www = path.join(__dirname, '../app/src/main/assets/www/js');
const RR = require(path.join(www, 'board.js'));
require(path.join(www, 'solver.js'));

// Plain breadth-first search over full robot layouts, used as ground truth.
function bruteForce(walls, robots, target, active, maxDepth) {
  const goal = (s) => (active >= 0 ? s[active] === target : s.includes(target));
  if (goal(robots)) return 0;
  const seen = new Set([robots.join(',')]);
  let frontier = [robots];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = [];
    for (const s of frontier) {
      for (let r = 0; r < s.length; r++) {
        for (let d = 0; d < 4; d++) {
          const to = RR.slide(walls, s, r, d);
          if (to === s[r]) continue;
          const t = s.slice();
          t[r] = to;
          if (goal(t)) return depth;
          const k = t.join(',');
          if (!seen.has(k)) { seen.add(k); next.push(t); }
        }
      }
    }
    frontier = next;
  }
  return -1;
}

let boards = 0, positions = 0, deepest = 0;
const histogram = {};
let slowest = 0;
for (let seed = 1; seed <= 40; seed++) {
  const board = RR.generateBoard(seed);
  boards++;

  // Structure: 17 targets, one of each colour/shape pair plus the vortex.
  assert.strictEqual(board.targets.length, 17);
  const kinds = new Set(board.targets.map((t) => t.color + ':' + t.shape));
  assert.strictEqual(kinds.size, 17);
  // Walls are mirrored on both sides.
  for (let c = 0; c < 256; c++) {
    for (let d = 0; d < 4; d++) {
      if (!(board.walls[c] & RR.BIT[d])) {
        const n = c + RR.OFFSET[d];
        assert.ok(n >= 0 && n < 256, 'open edge leaves the board');
        assert.ok(!(board.walls[n] & RR.BIT[RR.OPPOSITE[d]]), 'one-sided wall');
      }
    }
  }

  const rng = RR.mulberry32(seed * 101);
  for (let i = 0; i < 6; i++) {
    // Alternate between four robots and five (with the silver one).
    const robots = RR.randomRobots(rng, board, 4 + ((seed + i) & 1));
    const t = board.targets[RR.randInt(rng, 0, 16)];
    const cell = t.y * 16 + t.x;
    const active = t.color === RR.WILD ? -1 : t.color;
    const t0 = Date.now();
    const res = RR.solve(board.walls, robots, cell, active, { maxDepth: 14, maxSolutions: 200, timeMs: 20000 });
    slowest = Math.max(slowest, Date.now() - t0);
    positions++;
    histogram[res.depth] = (histogram[res.depth] || 0) + 1;
    deepest = Math.max(deepest, res.depth);

    // Every reported solution must really work and have the reported length.
    for (const moves of res.solutions) {
      assert.strictEqual(moves.length, res.depth);
      const end = RR.replay(board.walls, robots, moves).pop();
      assert.ok(RR.isSolved(end, t), 'solution does not reach the target');
    }
    // Optimality, checked against brute force where that is affordable.
    if (res.depth >= 0 && res.depth <= 4) {
      assert.strictEqual(bruteForce(board.walls, robots, cell, active, 4), res.depth);
    } else {
      assert.strictEqual(bruteForce(board.walls, robots, cell, active, 4), -1);
    }
    // A node budget must give the same answer every time (the daily puzzle relies on it).
    const a = RR.solve(board.walls, robots, cell, active, { maxDepth: 7, maxSolutions: 50, maxNodes: 200000 });
    const b = RR.solve(board.walls, robots, cell, active, { maxDepth: 7, maxSolutions: 50, maxNodes: 200000 });
    assert.deepStrictEqual(a, b);
    if (a.depth >= 0) assert.strictEqual(a.depth, res.depth);
    const distinct = RR.distinctSolutions(res.solutions, 5);
    assert.ok(res.depth < 0 || distinct.length >= 1);
  }
}
console.log(`ok: ${boards} boards, ${positions} positions, depth histogram`, histogram, `slowest ${slowest}ms`);
