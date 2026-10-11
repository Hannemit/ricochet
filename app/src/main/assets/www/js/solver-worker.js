// Runs the solver off the main thread so the board stays responsive.
importScripts('board.js', 'solver.js');

self.onmessage = function (e) {
  const q = e.data;
  const res = self.RR.solve(q.walls, q.robots, q.target, q.active, q.opts);
  self.postMessage({ id: q.id, result: res });
};
