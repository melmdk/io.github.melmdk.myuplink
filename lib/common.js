/* eslint-disable strict */
/* eslint-disable comma-dangle */

'use strict';

// -32767 is used for NIBE devices.
// -32768 is used for HOIAX devices.
const POINT_UNDEFINED_VALUES = [ -32767, -32768 ];
const POINT_STRING_FALLBACK_VALUE = '--';

// Device Point classifier
const TYPE = {
  UNKNOWN: null,
  NUMBER: 1,
  ENUM: 2
};

module.exports = {
  TYPE,
  POINT_UNDEFINED_VALUES,
  POINT_STRING_FALLBACK_VALUE
};
