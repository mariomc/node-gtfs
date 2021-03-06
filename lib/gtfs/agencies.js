const utils = require('../utils');

const Agency = require('../../models/gtfs/agency');

/*
 * Returns an array of all agencies that match the query parameters. A `within`
 * parameter containing `lat`, `lon` and optionally `radius` in miles may be
 * passed to search for agencies in a specific area.
 */
exports.getAgencies = (query = {}, projection = '-_id', options = {lean: true}) => {
  const {within, ...agencyQuery} = query;
  if (within !== undefined) {
    if (!within.lat || !within.lon) {
      throw new Error('`within` must contain `lat` and `lon`.');
    }

    let {lat, lon, radius} = within;
    if (radius === undefined) {
      radius = 25;
    }

    return Agency.find(query, projection, options)
      .near('agency_center', {
        center: [lon, lat],
        spherical: true,
        maxDistance: utils.milesToRadians(radius)
      });
  }

  return Agency.find(query, projection, options);
};
