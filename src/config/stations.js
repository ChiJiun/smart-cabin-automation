'use strict';

/**
 * Simulated fuel-station POI database (fictional names), loaded from stations.json
 * (fields: id, name, lat, lng). Distances are computed from the vehicle position
 * with the haversine formula.
 * Distances from the default position: 2.5, 6.6, 10.0, 15.6, 21.9, 24.1, 41.3 km.
 */
const STATIONS = require('./stations.json');

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

module.exports = { STATIONS, haversineKm };
