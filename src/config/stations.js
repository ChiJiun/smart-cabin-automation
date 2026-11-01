'use strict';

/**
 * Simulated fuel-station POI database (fictional names). Distances are computed
 * from the vehicle position with the haversine formula.
 * Distances from the default position: 2.5, 6.6, 10.0, 15.6, 21.9, 24.1, 41.3 km.
 */
const STATIONS = [
  { id: 'st-a', name: '信義示範加油站', lat: 25.0330, lng: 121.5902 },
  { id: 'st-b', name: '南港示範加油站', lat: 25.0330, lng: 121.6309 },
  { id: 'st-c', name: '汐止示範加油站', lat: 25.0730, lng: 121.6540 },
  { id: 'st-d', name: '新店示範加油站', lat: 24.8930, lng: 121.5654 },
  { id: 'st-e', name: '林口示範加油站', lat: 25.0730, lng: 121.3530 },
  { id: 'st-f', name: '基隆示範加油站', lat: 25.1530, lng: 121.7650 },
  { id: 'st-g', name: '桃園示範加油站', lat: 24.9930, lng: 121.1580 },
];

function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

module.exports = { STATIONS, haversineKm };
