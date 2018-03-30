const Calendar = require('../../models/gtfs/calendar');
const Trip = require('../../models/gtfs/trip');

/*
 * Returns an array of calendars that match the query parameters.
 */
exports.getCalendars = async (query = {}, projection = '-_id', options = {lean: true}) => {
  const {route_id, ...calendarQuery} = query;

  if (route_id !== undefined) {
    const tripQuery = {route_id: route_id};

    if (query.agency_key !== undefined) {
      tripQuery.agency_key = query.agency_key;
    }
    const serviceIds = await Trip.find(tripQuery).distinct('service_id');
    calendarQuery.service_id = {$in: serviceIds};
  }
  return Calendar.find(calendarQuery, projection, options);
};
