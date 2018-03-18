const mongoose = require('mongoose');

const TimetableStopOrder = mongoose.model('TimetableStopOrder', new mongoose.Schema({
  agency_key: {
    type: String,
    required: true,
    index: true
  },
  timetable_id: {
    type: String,
    index: true
  },
  timetable: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Timetable'
  },
  stop_id: String,
  stop: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Stop'
  },
  stop_sequence: Number
}));

module.exports = TimetableStopOrder;
