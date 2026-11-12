'use strict';

const path = require('path');
const express = require('express');
const { Engine } = require('./src/engine/Engine');

function createApp(engine = new Engine()) {
  const app = express();
  engine.setMaxListeners(0); // one 'change' listener per open dashboard (SSE)
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
    const { format = 'json' } = req.query;
    if (format !== 'json' && format !== 'csv') {
      res.status(400).json({ error: 'format 必須是 json 或 csv' });
      return;
    }
    if (format === 'csv') {
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

  // Body-parser errors (malformed JSON, oversized body) are answered as JSON like every other error,
  // instead of Express's default HTML page.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    let error = '伺服器錯誤';
    if (err.type === 'entity.too.large') error = '請求內容過大';
    else if (status < 500) error = '請求格式錯誤（內容必須是 JSON）';
    res.status(status).json({ error });
  });

  return app;
}

if (require.main === module) {
  const engine = new Engine();
  const app = createApp(engine);
  const port = Number(process.env.PORT) || 3000;
  // The API has no authentication, so by default only this computer can reach it. Set HOST=0.0.0.0
  // to open the dashboard from another device on the network (e.g. a phone during a demo).
  const host = process.env.HOST || '127.0.0.1';
  // Real-time simulation clock: one simulated second per real second while running.
  setInterval(() => { if (engine.state.clockRunning) engine.tick(1); }, 1000);
  const server = app.listen(port, host, () => {
    const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
    console.log(`Smart Cabin simulation running at http://${shown}:${port} (listening on ${host})`);
    console.log(`  Dashboard + TA console : http://${shown}:${port}/`);
    console.log(`  Configuration          : http://${shown}:${port}/config.html`);
    if (shown === 'localhost') console.log('  Other devices on the network can connect through the IP address of this computer (no authentication).');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`Port ${port} is already in use. Start with another port, e.g. PORT=8080 npm start`);
    else console.error(err.message);
    process.exit(1);
  });
}

module.exports = { createApp };
