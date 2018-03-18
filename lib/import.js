const path = require('path');
const {promisify} = require('util');

const _ = require('lodash');
const extract = require('extract-zip');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const parse = require('csv-parse');
const proj4 = require('proj4');
const untildify = require('untildify');

const extractAsync = promisify(extract);

const models = require('../models/models');
const utils = require('./utils');

const downloadFiles = async task => {
  task.log(`Downloading GTFS from ${task.agency_url}`);

  task.path = `${task.downloadDir}/${task.agency_key}-gtfs.zip`;

  const res = await fetch(task.agency_url);

  if (res.status !== 200) {
    throw new Error('Couldn\'t download files');
  }

  const buffer = await res.buffer();

  await fs.writeFile(task.path, buffer);
  task.log('Download successful');
};

const readFiles = async task => {
  const gtfsPath = untildify(task.path);
  task.log(`Importing GTFS from ${task.path}\r`);
  if (path.extname(gtfsPath) === '.zip') {
    try {
      await extractAsync(gtfsPath, {dir: task.downloadDir});
    } catch (err) {
      console.error(err);
      throw new Error(`Unable to unzip file ${task.path}`);
    }
  } else {
    // Local file is unzipped, just copy it from there.
    await fs.copy(gtfsPath, task.downloadDir);
  }
};

const removeData = task => {
  // Remove old db records based on agency_key
  return Promise.all(models.map(model => {
    return model.model.collection.remove({agency_key: task.agency_key});
  }));
};

const importLines = (lines, model, cb) => {
  const bulk = model.collection.initializeUnorderedBulkOp();
  const count = lines.length;

  if (!bulk) {
    return cb();
  }

  while (lines.length) {
    bulk.insert(lines.pop());
  }
  bulk.execute(err => {
    cb(err, count);
  });
};

const formatLine = (line, model, task) => {
  // Remove null values
  for (const key in line) {
    if (line[key] === null) {
      delete line[key];
    }
  }

  // Add agency_key
  line.agency_key = task.agency_key;

  // Convert fields that should be int
  const integerFields = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'start_date',
    'end_date',
    'date',
    'exception_type',
    'shape_pt_sequence',
    'payment_method',
    'transfers',
    'transfer_duration',
    'feed_start_date',
    'feed_end_date',
    'headway_secs',
    'exact_times',
    'route_type',
    'direction_id',
    'location_type',
    'wheelchair_boarding',
    'stop_sequence',
    'pickup_type',
    'drop_off_type',
    'use_stop_sequence',
    'transfer_type',
    'min_transfer_time',
    'wheelchair_accessible',
    'bikes_allowed',
    'timepoint',
    'timetable_sequence'
  ];

  integerFields.forEach(fieldName => {
    if (line[fieldName]) {
      line[fieldName] = parseInt(line[fieldName], 10);
    }
  });

  // Convert fields that should be float
  const floatFields = [
    'price',
    'shape_dist_traveled',
    'shape_pt_lat',
    'shape_pt_lon',
    'stop_lat',
    'stop_lon'
  ];

  floatFields.forEach(fieldName => {
    if (line[fieldName]) {
      line[fieldName] = parseFloat(line[fieldName]);
    }
  });

  // Make lat/lon array for stops
  if (line.stop_lat && line.stop_lon) {
    line.loc = [
      line.stop_lon,
      line.stop_lat
    ];

    // If coordinates are not specified, use [0,0]
    if (isNaN(line.loc[0])) {
      line.loc[0] = 0;
    }
    if (isNaN(line.loc[1])) {
      line.loc[1] = 0;
    }

    // Convert to epsg4326 if needed
    if (task.agency_proj) {
      line.loc = proj4(task.agency_proj, 'WGS84', line.loc);
      line.stop_lon = line.loc[0];
      line.stop_lat = line.loc[1];
    }
  }

  // Make lat/long for shapes
  if (line.shape_pt_lat && line.shape_pt_lon) {
    line.loc = [line.shape_pt_lon, line.shape_pt_lat];
  }

  return line;
};

const importFiles = async task => {
  task.agency_bounds = {
    sw: [],
    ne: []
  };

  // Loop through each GTFS file. Files must be imported in a specific order to build relationships
  for (const model of models) {
    await new Promise((resolve, reject) => {
      // Filter out excluded files from config
      if (task.exclude && _.includes(task.exclude, model.filenameBase)) {
        task.log(`Skipping - ${model.filenameBase}.txt\r`);
        return resolve();
      }

      const filepath = path.join(task.downloadDir, `${model.filenameBase}.txt`);

      if (!fs.existsSync(filepath)) {
        if (!model.nonstandard) {
          task.log(`Importing - ${model.filenameBase}.txt - No file found\r`);
        }
        return resolve();
      }

      task.log(`Importing - ${model.filenameBase}.txt\r`);

      const lines = [];
      const chunkSize = 10000;
      let lineCount = 0;
      let line;
      const parser = parse({
        columns: true,
        relax: true,
        trim: true
      });

      parser.on('readable', () => {
        while (line = parser.read()) {
          const formattedLine = formatLine(line, model, task);

          // Calculate agency bounds
          if (formattedLine.loc) {
            task.agency_bounds = utils.extendBounds(task.agency_bounds, formattedLine.loc);
          }

          lines.push(formattedLine);

          // If we have a bunch of lines ready to insert, then do it
          if (lines.length >= chunkSize) {
            importLines(lines, model.model, (err, count) => {
              if (err) {
                task.log(err);
              }

              lineCount += count;
              task.log(`Importing - ${model.filenameBase}.txt - ${lineCount} lines imported\r`, true);
            });
          }
        }
      });

      parser.on('end', () => {
        // Insert all remaining lines
        if (lines.length > 0) {
          importLines(lines, model.model, (err, count) => {
            if (err) {
              task.log(err);
            }

            lineCount += count;
            task.log(`Importing - ${model.filenameBase}.txt - ${lineCount} lines imported\r`, true);
            resolve();
          });
        } else {
          task.log(`Importing - ${model.filenameBase}.txt - ${lineCount} lines imported\r`, true);
          resolve();
        }
      });

      parser.on('error', reject);

      fs.createReadStream(filepath).pipe(parser);
    })
    .catch(err => {
      throw err;
    });
  }
};

const postProcess = async task => {
  task.log('Post Processing data');

  const agencyModel = _.find(models, {filenameBase: 'agency'});
  const calendarModel = _.find(models, {filenameBase: 'calendar'});
  const calendarDatesModel = _.find(models, {filenameBase: 'calendar_dates'});
  const fareAttributesModel = _.find(models, {filenameBase: 'fare_attributes'});
  const fareRulesModel = _.find(models, {filenameBase: 'fare_rules'});
  const frequenciesModel = _.find(models, {filenameBase: 'frequencies'});
  const routesModel = _.find(models, {filenameBase: 'routes'});
  const tripsModel = _.find(models, {filenameBase: 'trips'});
  const stopsModel = _.find(models, {filenameBase: 'stops'});
  const stopTimesModel = _.find(models, {filenameBase: 'stop_times'});
  const transfersModel = _.find(models, {filenameBase: 'transfers'});
  const shapesModel = _.find(models, {filenameBase: 'shapes'});
  const stopAttributesModel = _.find(models, {filenameBase: 'stop_attributes'});
  const timetablesModel = _.find(models, {filenameBase: 'timetables'});
  const timetableStopOrderModel = _.find(models, {filenameBase: 'timetable_stop_order'});
  const timetablePagesModel = _.find(models, {filenameBase: 'timetable_pages'});

  task.log(`Post Processing - Agencies\r`, true);
  const agencyCenter = utils.boundsCenter(task.agency_bounds);

  await agencyModel.model.collection.update({
    agency_key: task.agency_key
  }, {
    $set: {
      agency_bounds: task.agency_bounds,
      agency_center: agencyCenter,
      date_last_updated: Date.now()
    }
  });

  // Add Mongo relationships
  task.log(`Post Processing - Calendar Dates\r`, true);
  const calendarDates = await calendarDatesModel.model.find({agency_key: task.agency_key});
  await Promise.all(calendarDates.map(async calendarDate => {
    calendarDate.service = await calendarModel.model.findOne({
      agency_key: task.agency_key,
      service_id: calendarDate.service_id
    }, {_id: 1});

    await calendarDate.save();
  }));

  task.log(`Post Processing - Fare Rules\r`, true);
  const fareRules = await fareRulesModel.model.find({agency_key: task.agency_key});
  await Promise.all(fareRules.map(async fareRule => {
    if (fareRule.route_id !== '') {
      fareRule.route = await routesModel.model.findOne({
        agency_key: task.agency_key,
        route_id: fareRule.route_id
      }, {_id: 1});
    }

    fareRule.fare = await fareAttributesModel.model.findOne({
      agency_key: task.agency_key,
      fare_id: fareRule.fare_id
    }, {_id: 1});

    await fareRule.save();
  }));

  task.log(`Post Processing - Frequencies\r`, true);
  const frequencies = await frequenciesModel.model.find({agency_key: task.agency_key});
  await Promise.all(frequencies.map(async frequency => {
    frequency.trip = await tripsModel.model.findOne({
      agency_key: task.agency_key,
      trip_id: frequency.trip_id
    }, {_id: 1});

    await frequency.save();
  }));

  task.log(`Post Processing - Routes\r`, true);
  const routes = await routesModel.model.find({agency_key: task.agency_key});
  await Promise.all(routes.map(async route => {
    if (route.agency_id !== '') {
      route.agency = await agencyModel.model.findOne({
        agency_key: task.agency_key,
        agency_id: route.agency_id
      }, {_id: 1});
    }

    await route.save();
  }));

  // task.log(`Post Processing - Stop Times\r`, true);
  // const stopTimes = await stopTimesModel.model.find({agency_key: task.agency_key});
  // await Promise.all(stopTimes.map(async stopTime => {
  //   stopTime.trip = await tripsModel.model.findOne({
  //     agency_key: task.agency_key,
  //     trip_id: stopTime.trip_id
  //   }, {_id: 1});
  //
  //   stopTime.stop = await stopsModel.model.findOne({
  //     agency_key: task.agency_key,
  //     stop_id: stopTime.stop_id
  //   }, {_id: 1});
  //
  //   await stopTime.save();
  // }));

  task.log(`Post Processing - Transfers\r`, true);
  const transfers = await transfersModel.model.find({agency_key: task.agency_key});
  await Promise.all(transfers.map(async transfer => {
    transfer.from_stop = await stopsModel.model.findOne({
      agency_key: task.agency_key,
      stop_id: transfer.from_stop_id
    }, {_id: 1});

    transfer.to_stop = await stopsModel.model.findOne({
      agency_key: task.agency_key,
      stop_id: transfer.to_stop_id
    }, {_id: 1});

    await transfer.save();
  }));

  task.log(`Post Processing - Trips\r`, true);
  const trips = await tripsModel.model.find({agency_key: task.agency_key});
  await Promise.all(trips.map(async trip => {
    trip.route = await routesModel.model.findOne({
      agency_key: task.agency_key,
      route_id: trip.route_id
    }, {_id: 1});

    trip.service = await calendarModel.model.findOne({
      agency_key: task.agency_key,
      service_id: trip.service_id
    }, {_id: 1});

    // if (trip.shape_id !== '') {
    //   trip.shapes = await shapesModel.model.find({
    //     agency_key: task.agency_key,
    //     shape_id: trip.shape_id
    //   }, {_id: 1});
    // }

    await trip.save();
  }));

  task.log(`Post Processing - Stop Attributes\r`, true);
  const stopAttributes = await stopAttributesModel.model.find({agency_key: task.agency_key});
  await Promise.all(stopAttributes.map(async stopAttribute => {
    stopAttribute.stop = await stopsModel.model.findOne({
      agency_key: task.agency_key,
      stop_id: stopAttribute.stop_id
    }, {_id: 1});

    await stopAttribute.save();
  }));

  task.log(`Post Processing - Timetable Stop Order\r`, true);
  const timetableStopOrders = await timetableStopOrderModel.model.find({agency_key: task.agency_key});
  await Promise.all(timetableStopOrders.map(async timetableStopOrder => {
    timetableStopOrder.stop = await stopsModel.model.findOne({
      agency_key: task.agency_key,
      stop_id: timetableStopOrder.stop_id
    }, {_id: 1});

    timetableStopOrder.timetable = await timetablesModel.model.findOne({
      agency_key: task.agency_key,
      timetable_id: timetableStopOrder.timetable_id
    }, {_id: 1});

    await timetableStopOrder.save();
  }));

  task.log(`Post Processing - Timetables\r`, true);
  const timetables = await timetablesModel.model.find({agency_key: task.agency_key});
  await Promise.all(timetables.map(async timetable => {
    timetable.route = await routesModel.model.findOne({
      agency_key: task.agency_key,
      route_id: timetable.route_id
    }, {_id: 1});

    if (timetable.timetable_page_id !== '') {
      timetable.timetable_page = await timetablePagesModel.model.findOne({
        agency_key: task.agency_key,
        timetable_page_id: timetable.timetable_page_id
      }, {_id: 1});
    }

    await timetable.save();
  }));

  task.log(`Post Processing - Completed\r`, true);
};

const ensureIndexes = () => {
  return Promise.all(models.map(model => model.model.ensureIndexes()));
};

module.exports = async config => {
  const log = utils.log(config);

  const agencyCount = config.agencies.length;
  log(`Starting GTFS import for ${agencyCount} ${utils.pluralize('file', agencyCount)}`);

  for (const agency of config.agencies) {
    if (!agency.agency_key) {
      throw new Error('No Agency Key provided.');
    }

    if (!agency.url && !agency.path) {
      throw new Error('No Agency URL or path provided.');
    }

    const task = {
      exclude: agency.exclude,
      agency_key: agency.agency_key,
      agency_url: agency.url,
      path: agency.path,
      downloadDir: path.resolve('./gtfs-downloads'),
      skipDelete: config.skipDelete,
      log: (message, overwrite) => {
        log(`${task.agency_key}: ${message}`, overwrite);
      }
    };

    await fs.remove(task.downloadDir);
    await fs.ensureDir(task.downloadDir);

    if (task.agency_url) {
      await downloadFiles(task);
    }
    await readFiles(task);

    // Override using --skipDelete command line argument or `skipDelete` in config.json
    if (task.skipDelete === true) {
      task.log('Skipping deletion of existing data');
    } else {
      await removeData(task);
    }

    await importFiles(task);
    await postProcess(task);
    await ensureIndexes();

    await fs.remove(task.downloadDir);
    task.log('Completed GTFS import');
  }

  log(`Completed GTFS import for ${agencyCount} ${utils.pluralize('file', agencyCount)}\n`);
};
