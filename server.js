'use strict';

const path = require('path');
const express = require('express');
const { Engine } = require('./src/engine/Engine');

function createApp(engine = new Engine()) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  const wrap = (fn) => (req, res) => {
    try {
      const result = fn(req, res);
      if (!res.headersSent) res.json(result ?? engine.publicState());
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  };

  // ---- runtime state & simulation
  app.get('/api/state', wrap(() => engine.publicState()));
  app.post('/api/actions', wrap((req) => engine.dispatch(req.body)));

  // Server-Sent Events: pushes the full state on every change
  app.get('/api/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders();
    const send = () => res.write(`data: ${JSON.stringify(engine.publicState())}\n\n`);
    let pending = false;
    const onChange = () => {
      if (pending) return;
      pending = true;
      setImmediate(() => { pending = false; send(); });
    };
    engine.on('change', onChange);
    send();
    req.on('close', () => engine.off('change', onChange));
  });

  // ---- log export (TA reproducibility checks): full retained log as JSON or CSV
  app.get('/api/log', (req, res) => {
    if (req.query.format === 'csv') {
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="smart-cabin-log.csv"' });
      res.send(engine.exportLogCsv());
    } else {
      res.set('Content-Disposition', 'attachment; filename="smart-cabin-log.json"');
      res.json(engine.exportLog());
    }
  });

  // ---- configuration (zones / devices / settings)
  app.get('/api/config', wrap(() => engine.getConfig()));
  app.post('/api/zones', wrap((req) => { engine.addZone(req.body); return engine.getConfig(); }));
  app.put('/api/zones/:id', wrap((req) => { engine.updateZone(req.params.id, req.body); return engine.getConfig(); }));
  app.delete('/api/zones/:id', wrap((req) => { engine.deleteZone(req.params.id); return engine.getConfig(); }));
  app.post('/api/devices', wrap((req) => { engine.addDevice(req.body); return engine.getConfig(); }));
  app.put('/api/devices/:id', wrap((req) => { engine.updateDevice(req.params.id, req.body); return engine.getConfig(); }));
  app.delete('/api/devices/:id', wrap((req) => { engine.deleteDevice(req.params.id); return engine.getConfig(); }));
  app.put('/api/settings', wrap((req) => { engine.updateSettings(req.body); return engine.getConfig(); }));

  return app;
}

if (require.main === module) {
  const engine = new Engine();
  const app = createApp(engine);
  const port = Number(process.env.PORT) || 3000;
  // Real-time simulation clock: one simulated second per real second while running.
  setInterval(() => { if (engine.state.clockRunning) engine.tick(1); }, 1000);
  app.listen(port, () => {
    console.log(`Smart Cabin simulation running at http://localhost:${port}`);
    console.log(`  Dashboard + TA console : http://localhost:${port}/`);
    console.log(`  Configuration          : http://localhost:${port}/config.html`);
  });
}

module.exports = { createApp };
