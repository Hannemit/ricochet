// Canvas renderer for the board, targets, robots and move trails.
(function (root) {
  'use strict';

  const RR = root.RR;
  const SIZE = RR.SIZE;
  const TAU = Math.PI * 2;

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Draws a target symbol centred on (cx, cy). `colors` is the four robot
  // colours; `color` 4 is the wild vortex.
  function drawTarget(ctx, cx, cy, r, color, shape, colors) {
    ctx.save();
    ctx.lineJoin = 'round';
    if (color === RR.WILD) {
      ctx.lineWidth = r * 0.5;
      ctx.lineCap = 'butt';
      for (let i = 0; i < 4; i++) {
        ctx.strokeStyle = colors[i];
        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.68, i * TAU / 4 - 0.4, (i + 1) * TAU / 4 - 0.4);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    ctx.fillStyle = colors[color];
    ctx.beginPath();
    if (shape === 0) {
      ctx.arc(cx, cy, r * 0.86, 0, TAU);
    } else if (shape === 1) {
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.98, cy + r * 0.78);
      ctx.lineTo(cx - r * 0.98, cy + r * 0.78);
      ctx.closePath();
    } else if (shape === 2) {
      const s = r * 0.8;
      ctx.rect(cx - s, cy - s, s * 2, s * 2);
    } else {
      for (let i = 0; i < 10; i++) {
        const rad = i % 2 ? r * 0.48 : r * 1.08;
        const a = -Math.PI / 2 + i * TAU / 10;
        ctx.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
      }
      ctx.closePath();
    }
    ctx.fill();
    ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.stroke();
    ctx.restore();
  }

  function Renderer(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.layer = document.createElement('canvas');
    this.size = 0;
    this.cell = 0;
    this.board = null;
    this.scene = { robots: [], target: -1, trails: [], selected: -1, ghosts: [], hint: null };
    this.anim = null;
    this.frame = 0;
    this.theme = {};
    this.refreshTheme();
  }

  Renderer.prototype.refreshTheme = function () {
    this.theme = {
      board: cssVar('--board'),
      tile: cssVar('--tile'),
      tileAlt: cssVar('--tile-alt'),
      wall: cssVar('--wall'),
      center: cssVar('--center'),
      fg: cssVar('--fg'),
      robots: [cssVar('--r0'), cssVar('--r1'), cssVar('--r2'), cssVar('--r3'), cssVar('--r4')],
    };
    this.layerDirty = true;
    this.invalidate();
  };

  Renderer.prototype.resize = function (size) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.size = size;
    this.cell = size / SIZE;
    this.dpr = dpr;
    for (const c of [this.canvas, this.layer]) {
      c.width = Math.round(size * dpr);
      c.height = Math.round(size * dpr);
    }
    this.canvas.style.width = size + 'px';
    this.canvas.style.height = size + 'px';
    this.layerDirty = true;
    this.invalidate();
  };

  Renderer.prototype.setBoard = function (board) {
    this.board = board;
    this.layerDirty = true;
    this.invalidate();
  };

  Renderer.prototype.setScene = function (scene) {
    if (scene.target !== this.scene.target) this.layerDirty = true;
    this.scene = scene;
    this.invalidate();
  };

  // Slides robot `r` between two cells; the scene already holds the end state.
  Renderer.prototype.animateMove = function (r, from, to) {
    const dist = Math.abs((from % SIZE) - (to % SIZE)) + Math.abs((from >> 4) - (to >> 4));
    const dur = 90 + dist * 22;
    this.anim = { r, from, to, start: performance.now(), dur };
    this.invalidate();
    return dur;
  };

  Renderer.prototype.invalidate = function () {
    if (this.frame) return;
    this.frame = requestAnimationFrame((now) => {
      this.frame = 0;
      this.draw(now);
    });
  };

  Renderer.prototype.cellAt = function (clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const x = Math.floor((clientX - rect.left) / rect.width * SIZE);
    const y = Math.floor((clientY - rect.top) / rect.height * SIZE);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return -1;
    return y * SIZE + x;
  };

  Renderer.prototype.drawLayer = function () {
    const ctx = this.layer.getContext('2d');
    const s = this.cell;
    const th = this.theme;
    const board = this.board;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.size);

    roundRect(ctx, 0, 0, this.size, this.size, s * 0.3);
    ctx.fillStyle = th.board;
    ctx.fill();

    const gap = Math.max(0.5, s * 0.035);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        if (RR.isCenter(x, y)) continue;
        ctx.fillStyle = (x + y) % 2 ? th.tileAlt : th.tile;
        roundRect(ctx, x * s + gap, y * s + gap, s - gap * 2, s - gap * 2, s * 0.12);
        ctx.fill();
      }
    }

    // Centre block with the four robot colours.
    roundRect(ctx, 7 * s + gap, 7 * s + gap, 2 * s - gap * 2, 2 * s - gap * 2, s * 0.22);
    ctx.fillStyle = th.center;
    ctx.fill();
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = th.robots[i];
      ctx.beginPath();
      ctx.arc((7.62 + (i % 2) * 0.76) * s, (7.62 + (i >> 1) * 0.76) * s, s * 0.2, 0, TAU);
      ctx.fill();
    }

    if (!board) return;

    board.targets.forEach((t, i) => {
      const active = i === this.scene.target;
      const cx = (t.x + 0.5) * s;
      const cy = (t.y + 0.5) * s;
      if (active) {
        const glow = t.color === RR.WILD ? th.fg : th.robots[t.color];
        ctx.save();
        ctx.globalAlpha = 0.28;
        ctx.fillStyle = glow;
        roundRect(ctx, t.x * s + gap, t.y * s + gap, s - gap * 2, s - gap * 2, s * 0.12);
        ctx.fill();
        ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = active || this.scene.target < 0 ? 1 : 0.38;
      drawTarget(ctx, cx, cy, s * (active ? 0.34 : 0.27), t.color, t.shape, th.robots);
      ctx.restore();
    });

    ctx.strokeStyle = th.wall;
    ctx.lineWidth = Math.max(2, s * 0.15);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const w = board.walls[y * SIZE + x];
        // Outer frame and centre block are drawn as solid shapes instead.
        if ((w & 1) && y > 0 && !(RR.isCenter(x, y) && RR.isCenter(x, y - 1))) {
          ctx.moveTo(x * s, y * s); ctx.lineTo((x + 1) * s, y * s);
        }
        if ((w & 8) && x > 0 && !(RR.isCenter(x, y) && RR.isCenter(x - 1, y))) {
          ctx.moveTo(x * s, y * s); ctx.lineTo(x * s, (y + 1) * s);
        }
      }
    }
    ctx.stroke();

    const inset = ctx.lineWidth / 2;
    roundRect(ctx, inset, inset, this.size - inset * 2, this.size - inset * 2, s * 0.3);
    ctx.stroke();
  };

  Renderer.prototype.center = function (cell) {
    return [((cell % SIZE) + 0.5) * this.cell, ((cell >> 4) + 0.5) * this.cell];
  };

  Renderer.prototype.drawRobot = function (ctx, x, y, color, selected) {
    const s = this.cell;
    const r = s * 0.37;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.92, r * 0.85, r * 0.3, 0, 0, TAU);
    ctx.fill();

    if (selected) {
      ctx.strokeStyle = this.theme.fg;
      ctx.lineWidth = Math.max(1.5, s * 0.07);
      ctx.beginPath();
      ctx.arc(x, y, r + s * 0.085, 0, TAU);
      ctx.stroke();
    }

    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.45, r * 0.1, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.45, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.3)');
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.fillStyle = g;
    ctx.fill();

    // Visor with two eyes.
    ctx.fillStyle = 'rgba(16,18,28,0.82)';
    roundRect(ctx, x - r * 0.62, y - r * 0.34, r * 1.24, r * 0.56, r * 0.28);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x - r * 0.28, y - r * 0.06, r * 0.13, 0, TAU);
    ctx.arc(x + r * 0.28, y - r * 0.06, r * 0.13, 0, TAU);
    ctx.fill();
    ctx.restore();
  };

  Renderer.prototype.draw = function (now) {
    const ctx = this.ctx;
    const s = this.cell;
    const sc = this.scene;
    const th = this.theme;
    if (!this.size) return;
    if (this.layerDirty) {
      this.drawLayer();
      this.layerDirty = false;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.layer, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    let animating = false;
    let animPos = null;
    if (this.anim) {
      const a = this.anim;
      const t = Math.min(1, (now - a.start) / a.dur);
      const e = 1 - Math.pow(1 - t, 3);
      const p0 = this.center(a.from);
      const p1 = this.center(a.to);
      animPos = [p0[0] + (p1[0] - p0[0]) * e, p0[1] + (p1[1] - p0[1]) * e];
      if (t < 1) animating = true; else this.anim = null;
    }

    // Trails of the moves made so far.
    ctx.lineCap = 'round';
    ctx.lineWidth = s * 0.16;
    sc.trails.forEach((m, i) => {
      const p0 = this.center(m.from);
      let p1 = this.center(m.to);
      if (animPos && i === sc.trails.length - 1 && this.anim && this.anim.r === m.r) p1 = animPos;
      ctx.save();
      ctx.globalAlpha = 0.34;
      ctx.strokeStyle = th.robots[m.r];
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]);
      ctx.lineTo(p1[0], p1[1]);
      ctx.stroke();
      ctx.restore();
    });

    // Where the selected robot would stop in each direction.
    if (sc.selected >= 0 && !animating) {
      ctx.save();
      ctx.strokeStyle = th.robots[sc.selected];
      ctx.fillStyle = th.robots[sc.selected];
      ctx.lineWidth = Math.max(1.5, s * 0.07);
      for (const g of sc.ghosts) {
        const p = this.center(g);
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(p[0], p[1], s * 0.2, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 0.35;
        ctx.fill();
      }
      ctx.restore();
    }

    sc.robots.forEach((cell, i) => {
      let p = this.center(cell);
      if (animPos && this.anim && this.anim.r === i) p = animPos;
      this.drawRobot(ctx, p[0], p[1], th.robots[i], i === sc.selected);
    });

    // Hint arrow, gently pulsing.
    if (sc.hint && !animating) {
      const p0 = this.center(sc.hint.from);
      const p1 = this.center(sc.hint.to);
      const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
      const pulse = 0.65 + 0.35 * Math.sin(now / 260);
      const head = s * 0.42;
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = th.fg;
      ctx.fillStyle = th.fg;
      ctx.lineWidth = s * 0.12;
      ctx.setLineDash([s * 0.22, s * 0.2]);
      ctx.beginPath();
      ctx.moveTo(p0[0] + Math.cos(ang) * s * 0.5, p0[1] + Math.sin(ang) * s * 0.5);
      ctx.lineTo(p1[0] - Math.cos(ang) * head * 0.6, p1[1] - Math.sin(ang) * head * 0.6);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.translate(p1[0], p1[1]);
      ctx.rotate(ang);
      ctx.beginPath();
      ctx.moveTo(head * 0.45, 0);
      ctx.lineTo(-head * 0.55, -head * 0.55);
      ctx.lineTo(-head * 0.55, head * 0.55);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      animating = true;
    }

    if (animating) this.invalidate();
  };

  RR.Renderer = Renderer;
  RR.drawTarget = drawTarget;
  RR.cssVar = cssVar;
})(self);
