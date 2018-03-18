const mongoose = require('mongoose');

const Trip = mongoose.model('Trip', new mongoose.Schema({
  agency_key: {
    type: String,
    required: true,
    index: true
  },
  route_id: {
    type: String,
    required: true,
    index: true
  },
  route: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Route'
  },
  service_id: {
    type: String,
    required: true,
    index: true
  },
  service: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Calendar'
  },
  trip_id: {
    type: String,
    required: true,
    index: true
  },
  trip_headsign: String,
  trip_short_name: String,
  direction_id: {
    type: Number,
    index: true,
    min: 0,
    max: 1
  },
  block_id: String,
  shape_id: String,
  shapes: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Shape'
  }],
  wheelchair_accessible: {
    type: Number,
    min: 0,
    max: 2
  },
  bikes_allowed: {
    type: Number,
    min: 0,
    max: 2
  }
}));

module.exports = Trip;
