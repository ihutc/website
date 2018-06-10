const _ = require('lodash');
const async = require('async');
const cleanDeep = require('clean-deep');
const yaml = require('yamljs');
const request = require('request');

const settings = yaml.load('settings.yaml');

// SEQUELIZE
const Sequelize = require('sequelize');
const sequelizeConfig = require('../config/config.js');

let sequelize;

if (process.env.NODE_ENV === 'test') {
  sequelize = new Sequelize({
    storage: sequelizeConfig[process.env.NODE_ENV].storage,
    dialect: sequelizeConfig[process.env.NODE_ENV].dialect,
    dialectOptions: sequelizeConfig[process.env.NODE_ENV].dialectOptions,
  });
} else {
  sequelize = new Sequelize(sequelizeConfig[process.env.NODE_ENV].url, {
    dialect: sequelizeConfig[process.env.NODE_ENV].dialect,
    dialectOptions: sequelizeConfig[process.env.NODE_ENV].dialectOptions,
  });
}

const Organisation = sequelize.import('../models/organisation.js');

// Find what files have changed according to a GitHub push callback
// _json (string): Webhook payload from GitHub push event
function processDiffs(_json) {
  // Create result object
  let result = {
    'modified': [],
    'removed': [],
  };

  // Make sure JSON is in correct format
  let json = _json;

  if (typeof _json !== 'object') {
    json = JSON.parse(json);
  }

  // Reject if commit is not in master branch
  if (json.ref !== 'refs/heads/master') {
    return false;
  }

  // Reject if there are no commits
  if (json.commits.length === 0) {
    return false;
  }

  // Iterate through each commit and build a list of files to
  // update and delete
  json.commits.forEach(function(commit, index) {
    commit.added.forEach(function(commitAdded, index) {
      result.removed = _.remove(result.removed, function(n) {
        return n !== commitAdded;
      });

      if (result.modified.indexOf(commitAdded) === -1) {
        result.modified.push(commitAdded);
      }
    });

    commit.modified.forEach(function(commitModified, index) {
      // Check if already file is due to be removed
      result.removed = _.remove(result.removed, function(n) {
        return n !== commitModified;
      });

      if (result.modified.indexOf(commitModified) === -1) {
        result.modified.push(commitModified);
      }
    });

    commit.removed.forEach(function(commitRemoved, index) {
      // Check if already file is due to be removed
      result.modified = _.remove(result.modified, function(n) {
        return n !== commitRemoved;
      });

      if (result.removed.indexOf(commitRemoved) === -1) {
        result.removed.push(commitRemoved);
      }
    });
  });

  return result;
}

// Reject any malformed JSON files
function validateJSONString(json) {
  // Try to parse a string into JSON, if it fails
  // then return false
  try {
    let o = JSON.parse(json);

    if (o && typeof o === 'object') {
      return true;
    }
  } catch (e) { }

  return false;
}

// Handle any new or changed files
function handleModified(files, parentCallback) {
  let json;
  let filename = files[0];

  async.waterfall([
    function(callback) {
      let timestamp = Math.round((new Date()).getTime() / 1000);
      let url = `https://raw.githubusercontent.com/${settings.repository_path}`
        + `/master/${filename}?${timestamp}`;

      console.log(`--> Getting ${url}`);

      // Attempt to get the file from GitHub
      request({
        url: url,
        headers: {'User-Agent': settings.user_agent},
      }, function(err, res, body) {
        if (err) {
          callback('---> Problem making request');
        }

        if (res.statusCode !== 200) {
          callback('---> Unable to get file from GitHub');
        }

        callback(null, body);
      });
    },
    function(_json, callback) {
      // Check file for syntax errors
      if (!validateJSONString(_json)) {
        callback('---> Unable to parse JSON');
      }

      // Convert and store parsed JSON object
      json = JSON.parse(_json);

      // Validate JSON
      if (!validateRequiredFields(json)) {
        callback('---> Missing required fields');
      }

      // Remove empty fields
      json = cleanseJson(json);

      // Try and get name from OpenCorporates
      let url = `https://api.opencorporates.com/companies/`
        + `${json.organisationInformation.registrationCountry.toLowerCase()}/`
        + `${json.organisationInformation.number}`;

      console.log(`---> Getting ${url}`);

      request(url, function(err, res, body) {
        let name = '';

        if (res.statusCode === 200) {
          // Company information available on OpenCorporates
          try {
            let openCorporates = JSON.parse(body);
            name = openCorporates.results.company.name;
            console.log('----> Successfully retreived from OpenCorporates');
          } catch (e) {
            name = json.organisationInformation.name;
            console.log('----> Failed to get info from OpenCorporates');
          }
        } else {
          name = json.organisationInformation.name;
          console.log('----> Failed to get info from OpenCorporates');
        }

        upsert({
          'name': name,
          'registrationNumber': json.organisationInformation.number,
          'registrationCountry': json.organisationInformation
                                      .registrationCountry,
          'payload': json,
          'filename': filename,
        }, callback);
      });
    },
  ], function(err) {
    if (err) {
      console.log(err);
    }

    files.shift();

    if (files.length === 0) {
      parentCallback(null);
    } else {
      handleModified(files, parentCallback);
    }
  });
}

// Handle any deleted files
function handleDeleted(files, parentCallback) {
  let file = files[0];

  async.waterfall([
    function(callback) {
      Organisation.findOne({
        where: {
          filename: file,
        },
      }).then(function(obj) {
        obj.destroy().then(function() {
          callback(null);
        }).catch(function() {
          callback(`-> Unable to destroy entry for ${file}`);
        });
      }).catch(function() {
        callback(`-> Unable to find entry for ${file}`);
      });
    },
  ], function(err) {
    if (err) {
      console.log(err);
    }

    files.shift();

    if (files.length === 0) {
      parentCallback(null);
    } else {
      handleDeleted(files, parentCallback);
    }
  });
}

// Validate JSON for required fields
function validateRequiredFields(json) {
  try {
    if (json.organisationInformation) {
      let org = json.organisationInformation;

      if (org.name && org.number && org.registrationCountry) {
        return true;
      } else {
        return false;
      }
    } else {
      return false;
    }
  } catch (e) {
    return false;
  }
}

// Cleanse JSON
function cleanseJson(json) {
  // Remove any isMissing: false objects
  for (let root in json) {
    if (json.hasOwnProperty(root)) {
      let itemRoot = json[root];

      if (itemRoot.isMissing === false) {
        delete json[root].isMissing;
      }
    }
  }

  json = cleanDeep(json);

  return json;
}

// Insert new entries or update existing ones
function upsert(row, parentCallback) {
  Organisation.findOne({
    where: {
      'filename': row.filename,
    },
  }).then(function(obj) {
    if (obj) {
      // Update
      obj.update(row).then(function() {
        parentCallback(null);
      });
    } else {
      // Insert
      Organisation.create(row).then(function() {
        parentCallback(null);
      });
    }
  }).catch(function() {
    parentCallback('Error doing upsert');
  });
}

module.exports = {
  processDiffs,
  validateJSONString,
  handleModified,
  handleDeleted,
  validateRequiredFields,
  cleanseJson,
};
