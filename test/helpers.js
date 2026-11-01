'use strict';
const { Engine } = require('../src/engine/Engine');

function setup() {
  const e = new Engine();
  e.state.clockRunning = false;
  const dev = (id) => e.state.devices.find((d) => d.id === id);
  const act = (type, payload = {}) => e.dispatch({ type, ...payload });
  return { e, dev, act, s: () => e.state };
}
module.exports = { setup };
