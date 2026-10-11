// Board model: generation, walls and robot movement.
// Cells are indexed y * 16 + x. Each cell holds a 4-bit wall mask (N, E, S, W).
(function (root) {
  'use strict';

  const SIZE = 16;
  const CELLS = SIZE * SIZE;
  const N = 0, E = 1, S = 2, W = 3;
  const BIT = [1, 2, 4, 8];
  const OFFSET = [-SIZE, 1, SIZE, -1];
  const OPPOSITE = [S, W, N, E];
  const WILD = 4;
  const ROBOT_COUNT = 4;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randInt(rng, lo, hi) {
    return lo + Math.floor(rng() * (hi - lo + 1));
  }

  function shuffle(rng, arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  function isCenter(x, y) {
    return (x === 7 || x === 8) && (y === 7 || y === 8);
  }

  function addWall(walls, x, y, dir) {
    walls[y * SIZE + x] |= BIT[dir];
    const nx = x + (dir === E ? 1 : dir === W ? -1 : 0);
    const ny = y + (dir === S ? 1 : dir === N ? -1 : 0);
    if (nx >= 0 && nx < SIZE && ny >= 0 && ny < SIZE) {
      walls[ny * SIZE + nx] |= BIT[OPPOSITE[dir]];
    }
  }

  // Lays out a board the way the physical game does: four quadrants, each with
  // two stub walls on its outer edges and one L-shaped corner per colour, plus
  // a single wild "vortex" corner somewhere on the board.
  function generateBoard(seed) {
    for (let attempt = 0; ; attempt++) {
      const board = tryGenerate((seed + attempt * 7919) >>> 0);
      if (board) {
        board.seed = seed;
        return board;
      }
    }
  }

  function tryGenerate(seed) {
    const rng = mulberry32(seed);
    const walls = new Array(CELLS).fill(0);

    for (let i = 0; i < SIZE; i++) {
      addWall(walls, i, 0, N);
      addWall(walls, i, SIZE - 1, S);
      addWall(walls, 0, i, W);
      addWall(walls, SIZE - 1, i, E);
    }
    addWall(walls, 7, 7, N); addWall(walls, 7, 7, W);
    addWall(walls, 8, 7, N); addWall(walls, 8, 7, E);
    addWall(walls, 7, 8, S); addWall(walls, 7, 8, W);
    addWall(walls, 8, 8, S); addWall(walls, 8, 8, E);

    // Stub walls: one per half of every outer edge.
    for (const base of [1, 9]) {
      addWall(walls, randInt(rng, base, base + 4), 0, E);
      addWall(walls, randInt(rng, base, base + 4), SIZE - 1, E);
      addWall(walls, 0, randInt(rng, base, base + 4), S);
      addWall(walls, SIZE - 1, randInt(rng, base, base + 4), S);
    }

    const targets = [];
    const wildQuadrant = randInt(rng, 0, 3);
    for (let q = 0; q < 4; q++) {
      const x0 = (q & 1) ? 8 : 0;
      const y0 = (q & 2) ? 8 : 0;
      const colors = shuffle(rng, [0, 1, 2, 3]);
      if (q === wildQuadrant) colors.push(WILD);
      const corners = shuffle(rng, [0, 1, 2, 3]);
      for (let k = 0; k < colors.length; k++) {
        let placed = false;
        for (let tries = 0; tries < 200 && !placed; tries++) {
          const x = x0 + randInt(rng, 0, 7);
          const y = y0 + randInt(rng, 0, 7);
          if (x < 1 || x > 14 || y < 1 || y > 14) continue;
          if (x >= 6 && x <= 9 && y >= 6 && y <= 9) continue;
          let clash = false;
          for (const t of targets) {
            if (Math.abs(t.x - x) < 2 && Math.abs(t.y - y) < 2) { clash = true; break; }
          }
          if (clash) continue;
          const corner = corners[k % 4];
          addWall(walls, x, y, (corner & 1) ? N : S);
          addWall(walls, x, y, (corner & 2) ? E : W);
          const color = colors[k];
          targets.push({
            x, y, color,
            shape: color === WILD ? WILD : (color + q) % 4,
          });
          placed = true;
        }
        if (!placed) return null;
      }
    }
    return { walls, targets };
  }

  function randomRobots(rng, board) {
    const taken = new Set();
    for (const t of board.targets) taken.add(t.y * SIZE + t.x);
    const robots = [];
    while (robots.length < ROBOT_COUNT) {
      const x = randInt(rng, 0, SIZE - 1);
      const y = randInt(rng, 0, SIZE - 1);
      const c = y * SIZE + x;
      if (isCenter(x, y) || taken.has(c)) continue;
      taken.add(c);
      robots.push(c);
    }
    return robots;
  }

  // Where robot `index` stops when pushed in `dir`.
  function slide(walls, robots, index, dir) {
    let p = robots[index];
    const bit = BIT[dir];
    const off = OFFSET[dir];
    for (;;) {
      if (walls[p] & bit) return p;
      const n = p + off;
      for (let i = 0; i < robots.length; i++) {
        if (robots[i] === n) return p;
      }
      p = n;
    }
  }

  // Replays a move list; returns every intermediate robot layout.
  function replay(walls, start, moves) {
    const states = [start.slice()];
    let cur = start.slice();
    for (const m of moves) {
      cur = cur.slice();
      cur[m.r] = slide(walls, cur, m.r, m.d);
      states.push(cur);
    }
    return states;
  }

  function isSolved(robots, target) {
    const cell = target.y * SIZE + target.x;
    if (target.color === WILD) return robots.indexOf(cell) >= 0;
    return robots[target.color] === cell;
  }

  const api = {
    SIZE, CELLS, N, E, S, W, BIT, OFFSET, OPPOSITE, WILD, ROBOT_COUNT,
    mulberry32, shuffle, randInt, isCenter,
    generateBoard, randomRobots, slide, replay, isSolved,
  };
  root.RR = Object.assign(root.RR || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = root.RR;
})(typeof self !== 'undefined' ? self : globalThis);
