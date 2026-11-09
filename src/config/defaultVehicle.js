'use strict';

/**
 * Default vehicle configuration, loaded from the built-in JSON data file.
 * "Reset" restores runtime state from the current configuration; "Factory reset"
 * also restores this configuration.
 *
 * defaultVehicle.json
 *   settings    : capacityW (alternator output), batteryW (capacity when the alternator
 *                 has failed), thresholds for every behavior.
 *   zones       : vehicle zones (id, name).
 *   devices     : device topology; `initial` is the runtime state applied on reset
 *                 (on / level / auto / load).
 *   environment : ambient temperature, remaining range and GPS position.
 */
const data = require('./defaultVehicle.json');

const DEFAULT_SETTINGS = data.settings;
const DEFAULT_ZONES = data.zones;
const DEFAULT_DEVICES = data.devices;
const DEFAULT_ENVIRONMENT = data.environment;

module.exports = { DEFAULT_SETTINGS, DEFAULT_ZONES, DEFAULT_DEVICES, DEFAULT_ENVIRONMENT };
