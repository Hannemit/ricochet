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
  const SILVER = 4;

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

  // The eight quadrant faces of the original board game: four square pieces,
  // each printed on both sides (A and B). Every face is written in the
  // orientation it has in the top-left corner, eight cells per row. A cell
  // lists its walls (N, E, S, W) and, if it holds a target, the target's colour
  // (Red, Green, Blue, Yellow) and shape (Circle, Triangle, sQuare, Hexagon).
  // Layout data as transcribed in Michael Fogleman's open-source solver
  // (github.com/fogleman/Ricochet). It does not include the wild vortex target.
  const QUADRANTS = [
    [
      'NW,N,N,N,NE,NW,N,N,W,S,X,X,X,X,SEYH,W,WE,NWGT,X,X,X,X,N,X,W,X,X,X,X,X,X,X,' +
      'W,X,X,X,X,X,S,X,SW,X,X,X,X,X,NEBQ,W,NW,X,E,SWRC,X,X,X,S,W,X,X,N,X,X,E,NW',
      'NW,NE,NW,N,NS,N,N,N,W,S,X,E,NWRC,X,X,X,W,NEGT,W,X,X,X,X,X,W,X,X,X,X,X,SEYH,W,' +
      'W,X,X,X,X,X,N,X,SW,X,X,X,X,X,X,X,NW,X,E,SWBQ,X,X,X,S,W,X,X,N,X,X,E,NW',
    ],
    [
      'NW,N,N,NE,NW,N,N,N,W,X,X,X,X,E,SWBC,X,W,S,X,X,X,X,N,X,W,NEYT,W,X,X,S,X,X,' +
      'W,X,X,X,E,NWGQ,X,X,W,X,SERH,W,X,X,X,X,SW,X,N,X,X,X,X,S,NW,X,X,X,X,X,E,NW',
      'NW,N,N,N,NE,NW,N,N,W,X,SERH,W,X,X,X,X,W,X,N,X,X,X,X,X,WE,SWGQ,X,X,X,X,S,X,' +
      'SW,N,X,X,X,E,NWYT,X,NW,X,X,X,X,S,X,X,W,X,X,X,X,NEBC,W,S,W,X,X,X,X,X,E,NW',
    ],
    [
      'NW,N,N,NE,NW,N,N,N,W,X,X,X,X,SEGH,W,X,WE,SWRQ,X,X,X,N,X,X,SW,N,X,X,X,X,S,X,' +
      'NW,X,X,X,X,E,NWYC,X,W,X,S,X,X,X,X,X,W,X,NEBT,W,X,X,X,S,W,X,X,X,X,X,E,NW',
      'NW,N,NS,N,NE,NW,N,N,W,E,NWYC,X,X,X,X,X,W,X,X,X,X,X,X,X,W,X,X,X,X,E,SWBT,X,' +
      'SW,X,X,X,S,X,N,X,NW,X,X,X,NERQ,W,X,X,W,SEGH,W,X,X,X,X,S,W,N,X,X,X,X,E,NW',
    ],
    [
      'NW,N,N,NE,NW,N,N,N,W,X,X,X,X,X,X,X,W,X,X,X,X,SEBH,W,X,W,X,S,X,X,N,X,X,' +
      'SW,X,NEGC,W,X,X,X,X,NW,S,X,X,X,X,E,SWRT,WE,NWYQ,X,X,X,X,X,NS,W,X,X,X,X,X,E,NW',
      'NW,N,N,NE,NW,N,N,N,WE,SWRT,X,X,X,X,S,X,W,N,X,X,X,X,NEGC,W,W,X,X,X,X,X,X,X,' +
      'W,X,SEBH,W,X,X,X,S,SW,X,N,X,X,X,E,NWYQ,NW,X,X,X,X,X,X,S,W,X,X,X,X,X,E,NW',
    ],
  ];

  // Builds a board the way players do: pick a side of each of the four
  // pieces, shuffle them, and turn each so its notched corner meets the centre.
  function generateBoard(seed) {
    const rng = mulberry32(seed);
    const walls = new Array(CELLS).fill(0);
    const targets = [];
    const faces = shuffle(rng, QUADRANTS.map((pair) => pair[rng() < 0.5 ? 0 : 1]));
    const corners = [[0, 0], [8, 0], [8, 8], [0, 8]]; // clockwise from top-left
    faces.forEach((face, turns) => {
      const [x0, y0] = corners[turns];
      face.split(',').forEach((cell, i) => {
        let x = i % 8;
        let y = i >> 3;
        for (let k = 0; k < turns; k++) { const t = x; x = 7 - y; y = t; }
        for (const ch of cell) {
          const dir = 'NESW'.indexOf(ch);
          if (dir >= 0) addWall(walls, x0 + x, y0 + y, (dir + turns) % 4);
        }
        const target = /([RGBY])([CTQH])/.exec(cell);
        if (target) {
          targets.push({ x: x0 + x, y: y0 + y, color: 'RGBY'.indexOf(target[1]), shape: 'CTQH'.indexOf(target[2]) });
        }
      });
    });
    return { seed, walls, targets };
  }

  // `count` is 4, or 5 to include the silver robot (which has no target of its own).
  function randomRobots(rng, board, count) {
    const taken = new Set();
    for (const t of board.targets) taken.add(t.y * SIZE + t.x);
    const robots = [];
    while (robots.length < count) {
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
    SIZE, CELLS, N, E, S, W, BIT, OFFSET, OPPOSITE, WILD, SILVER,
    mulberry32, shuffle, randInt, isCenter,
    generateBoard, randomRobots, slide, replay, isSolved,
  };
  root.RR = Object.assign(root.RR || {}, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = root.RR;
})(typeof self !== 'undefined' ? self : globalThis);
