/* eslint-disable no-nested-ternary */
/* eslint-disable no-multi-spaces */
/* eslint-disable node/no-unsupported-features/es-syntax */
/* eslint-disable comma-dangle */

'use strict';

const fs = require('fs');

const { OAuth2Client, OAuth2Error, fetch } = require('homey-oauth2app');
const { evaluate } = require('mathjs');
const { TYPE, POINT_UNDEFINED_VALUES, POINT_STRING_FALLBACK_VALUE } = require('./common');
const Homey = require('homey');

// Bound every myUplink request. node-fetch applies no deadline of its own, and a request
// that connects but never answers leaves synchronizeStates' finally block unreached, which
// permanently kills that device's polling loop (JPIREQ-3895).
const REQUEST_TIMEOUT_MS = 30000;

// Token fetches bypass onBuildRequest and need their own deadline. A hang here strands
// OAuth2Client._refreshingToken, and _executeRequest awaits that promise before every
// request, so a single stuck refresh blocks all devices and all flow actions.
const TOKEN_TIMEOUT_MS = 30000;

// Backstop for the polling loop. One synchronizeStates pass makes only a handful of
// requests, so exceeding this means an await that will never settle. Re-arm the timer
// rather than lose the loop entirely.
const SYNC_WATCHDOG_MS = 180000;
// const myUplinkOAuth2Token = require('./myUplinkOAuth2Token.js');

class myUplinkOAuth2Client extends OAuth2Client {

  // Required:
  static BASE_URL = Homey.env.MYUPLINK_API_URL;
  static API_URL = `${myUplinkOAuth2Client.BASE_URL}/v2`;
  static TOKEN_URL = `${myUplinkOAuth2Client.BASE_URL}/oauth/token`;
  static AUTHORIZATION_URL = `${myUplinkOAuth2Client.BASE_URL}/oauth/authorize`;
  static SCOPES = ['READSYSTEM WRITESYSTEM offline_access'];

  // Optional:
  // static TOKEN = myUplinkOAuth2Token; // Default: OAuth2Token
  // static REDIRECT_URL = 'https://callback.athom.com/oauth2/callback'; // Default: 'https://callback.athom.com/oauth2/callback'

  // onHandleNotOK does not need to be overloaded
  // async onHandleNotOK({ body }) {
  //   throw new OAuth2Error(body.error);
  // }

  /**
   * Attach a deadline to every request that goes through OAuth2Client._executeRequest.
   *
   * This also awaits an in-flight token refresh *before* the Authorization header is
   * built. _executeRequest builds the request first and only then awaits
   * _refreshingToken, so without this a request queued behind a refresh is signed with
   * the pre-refresh access token and is guaranteed to come back 401.
   */
  async onBuildRequest(req) {
    if (this._refreshingToken) {
      try {
        await this._refreshingToken;
      } catch (err) {
        // Let the request below fail on its own merits (401 -> refresh -> retry).
        this.log(`Pending token refresh failed before request: ${err.message}`);
      }
    }

    const built = await super.onBuildRequest(req);
    built.opts.timeout = REQUEST_TIMEOUT_MS;
    return built;
  }

  /**
   * Refresh the token with a deadline that actually cancels the request.
   *
   * OAuth2Client.onRefreshToken fetches the token endpoint directly, so the deadline
   * onBuildRequest attaches to every other request never reaches it. Racing the promise
   * is not enough either: it frees refreshToken() - and with it every request waiting on
   * _refreshingToken - but leaves the socket open, so a token endpoint that accepts and
   * then goes silent leaks one connection per poll for the length of the outage.
   *
   * node-fetch honours opts.timeout by destroying the socket, and the only way to pass it
   * is to issue the request here. Everything past the fetch is delegated back to the SDK's
   * own handlers; keep this in step with OAuth2Client.onRefreshToken when it is upgraded.
   */
  async onRefreshToken() {
    const token = this.getToken();
    if (!token) {
      throw new OAuth2Error('Missing Token');
    }
    if (!token.isRefreshable()) {
      throw new OAuth2Error('Token cannot be refreshed');
    }

    const body = new URLSearchParams();
    body.append('grant_type', 'refresh_token');
    body.append('client_id', this._clientId);
    body.append('client_secret', this._clientSecret);
    body.append('refresh_token', token.refresh_token);

    const response = await fetch(this._tokenUrl, {
      body,
      method: 'POST',
      timeout: TOKEN_TIMEOUT_MS,
    });

    if (!response.ok) {
      return this.onHandleRefreshTokenError({ response });
    }

    this._token = await this.onHandleRefreshTokenResponse({ response });
    this.save();
    return this.getToken();
  }

  /**
   * Treat 403 as a refresh trigger, not just 401.
   *
   * homey-oauth2app refreshes reactively and only on 401, per RFC 6750, which requires
   * 401 for an expired bearer token and reserves 403 for a valid token without the
   * necessary permissions. The myUplink stage gateway answers 403 for an expired - and
   * for an entirely absent - access token, so no refresh is ever attempted: every later
   * poll reuses the dead token and the device stays unavailable until it is re-paired.
   * Symptom is clean polling for the ~65 minute token lifetime, then an unbroken run of
   * 403s. Production answers 401 today, so this override is what keeps the two
   * environments behaving alike.
   *
   * A genuine permission-denied 403 costs one wasted refresh - _executeRequest retries
   * with didRefreshToken = true and then throws, so this cannot loop.
   */
  async onShouldRefreshToken({ status }) {
    return status === 401 || status === 403;
  }

  /**
   * A permanently invalid refresh token surfaces as a generic 'Network problem', and
   * homey-oauth2app never emits 'expired', so nothing tells the user to sign in again.
   * Detect that case so the device can say what actually needs doing.
   */
  isAuthorizationFailure(error) {
    const message = String((error && error.message) || error);
    return /Token refresh failed|Token cannot be refreshed|Missing Token|invalid_grant|invalid_client|unauthorized/i.test(message);
  }

  async onInit() {
    this.log('*** MYUPLINK onInit ***');
    this.pendingDevicePoints = {};   // Array of [deviceId][devicePoint], filled with the values a devicePoint should be set to before being set
    this.confirmedDevicePoints = {}; // Array of [deviceId][devicePoint], filled with the values of the device points that has been read
    this.doPrefetch = {};            // Array of [deviceId][devicePoint], filled with True upon request. Which will initiate prefetch of the devicepoints
    this.deviceMap = {};             // Array of [deviceId]  = array of instanceId that control this deviceId
    this.devices = [];               // Array of [instanceId] =
    // Per-device data: { device, deviceId, driverId, deviceDefinition, vars, keyMap, reverseKeyMap, updateID,
    //                    errCnt, timeSinceCapRefresh, timeSinceCacheRefresh, timeSinceSettingsRefresh,
    //                    settingTypes, doneInit }
  }

  async onUninit() {
    this.log('*** MYUPLINK onUninit ***');
    for (let i = 0; i < this.devices.length; i++) {
      this.unInitDevice(i);
    }
  }

  // True when the entire string matches the regexp filter (^ and $ are not required in the regexp)
  stringMatch(string, filter) {
    const re = new RegExp(`^${filter}$`);
    return string.match(re) !== null;
  }
  
  async discoverDevicesPrivate(filterDefinitions = [{ filter: {} }]) {
    const deviceList = await this.executeWithTimeout(
      this.getFilteredDevices,
      60000, // 1 minute.
      filterDefinitions);

    if (deviceList.length > 1) {
      deviceList.forEach(device => device.name = `${device.name} (${device.data.systemName})`);
    }
  
    return deviceList.sort((device1, device2) => device1.name.localeCompare(device2.name));
  }

  async getFilteredDevices(filterDefinitions) {
    const deviceList = [];
    let systemsResponse = { numItems: 0, itemsPerPage: 0 };
    let page = 1;

    try {
      while (systemsResponse.numItems === systemsResponse.itemsPerPage) {
        systemsResponse = await this.getSystems({ page: page++, itemsPerPage: 10 });
    
        for (const system of systemsResponse.systems) {
          for (const device of system.devices) {
            this.log(`Discovering ${system.name} : ${device.id}`);
            const criteria = this.getMatchingCriteria(device);
  
            // The first matching definition wins, except that definitions marked
            // "additional" (e.g. an outdoor unit reported through its indoor module)
            // are always offered next to it as a separate Homey device.
            let primaryFound = false;
            for (const filterDefinition of filterDefinitions) {
              if (primaryFound && !filterDefinition.additional) continue;
              if (await this.doesDefinitionMatchCriteria(filterDefinition, criteria)) {
                deviceList.push(await this.createDeviceData(filterDefinition, device, system));
                if (!filterDefinition.additional) primaryFound = true;
              }
            }
          }
        }
      }
    } catch (error) {
      this.error(error);
    } finally {
      return deviceList;
    }
  }

  async doesDefinitionMatchCriteria(filterDefinition, criteria) {
    for (const criterion of criteria) {
      const criterionResult = await criterion(filterDefinition.filter);

      if (!criterionResult) {
        return false;
      }
    }

    return true;
  }

  getMatchingCriteria = (device) => [
    // deviceName, deviceType, deviceId filters.
    (filter) => !filter.deviceName || this.stringMatch(device.product.name, filter.deviceName),
    (filter) => !filter.deviceType || this.stringMatch(device.deviceType, filter.deviceType),
    (filter) => !filter.deviceId || this.stringMatch(device.id, filter.deviceId),

    // firmwareId filter.
    async (filter) => {
      if (!filter.firmwareId) {
        return true;
      }

      const deviceFirmware = await this.getDeviceFirmware(device.id);
      return this.stringMatch(deviceFirmware.firmwareId, filter.firmwareId);
    },

    // parameterId filter.
    async (filter) => {
      if (!filter.parameterId) {
        return true;
      }

      const parameterData = await this.getDevicePoints(device.id, filter.parameterId);
      return parameterData && parameterData[0].value === filter.value;
    }
  ];

  async createDeviceData(definitionOptions, device, system) {
    const deviceName = definitionOptions.name ?? system.name;

    let optionalPointIds = [];
    const optionalPointsQuery = definitionOptions.capabilities
      .filter(capability => capability.optional)
      .map(capability => capability.pointId)
      .join(',');

    if (optionalPointsQuery)
    {
      console.log(`Optional points query: ${optionalPointsQuery}`);
      optionalPointIds = (await this.getDevicePoints(
          device.id,
          optionalPointsQuery))
        .map(data => data.parameterId);
    }

    return {
      name: deviceName,
      icon: `../../../assets/icons/${definitionOptions.icon}`,
      data: {
        definitionFile: definitionOptions.filename,
        systemId: system.systemId,
        systemName: system.name,
        deviceId: device.id,
        deviceSerial: device.product.serialNumber,
        deviceName: device.product.name
      },

      capabilities: definitionOptions.capabilities.filter(
        capability => !capability.optional ||
        optionalPointIds.includes(capability.pointId))
        .map(capability => capability.id)
      
      // More properties can be configured such as: settings, class, capabilitiesOptions.
      // See https://apps.developer.homey.app/the-basics/devices/pairing#device-pairing-data
    };
  }

  addLanguage(dest, input) {
    const {
      baseLangCode, baseLang, noLang, newLangCode, newLang
    } = input;
    const keys = Object.keys(newLang);
    for (let i = 0; i < keys.length; i++) {
      const key = Array.isArray(newLang) ? +keys[i] : keys[i];
      if (typeof newLang[key] === 'function') {
        throw new Error('Extracted data should not be a function!');
      } else if (newLang[key] === null) {
        dest[key] = null;
      } else if (typeof newLang[key] === 'object') {
        if (dest[key] === undefined) {
          if (Array.isArray(newLang[key])) {
            dest[key] = [];
          } else {
            dest[key] = {};
          }
        }
        this.addLanguage(dest[key], {
          baseLangCode,
          newLangCode,
          baseLang: baseLang[key],
          noLang: noLang[key],
          newLang: newLang[key]
        });
      } else if (dest[key] === undefined && key !== 'timestamp') {
        dest[key] = newLang[key];
      } else if (dest[key] !== newLang[key]) {
        if (newLang[key] === baseLang[key]) continue;
        if (dest[key][baseLangCode] !== baseLang[key]) {
          if (Array.isArray(baseLang[key])) {
            dest[key] = [];
          } else {
            dest[key] = {};
          }
          dest[key][baseLangCode] = baseLang[key];
        }
        dest[key][newLangCode] = newLang[key];
      } // Else new value is equal... ignore
    }
  }

  combineLanguages(input) {
    const languages = Object.keys(input);
    const output = [];
    for (let i = 0; i < languages.length; i++) {
      if (languages[i] === 'none') continue;
      this.addLanguage(output, {
        baseLangCode: 'en',
        newLangCode: languages[i],
        baseLang: input['en'],
        noLang: input['none'],
        newLang: input[languages[i]]
      });
    }
    return output;
  }

  async dumpAllState() {
    const deviceList = await this.discoverDevicesPrivate();
    for (let i = 0; i < deviceList.length; i++) {
      try {
        this.log(`Processing device ${deviceList[i].data.deviceId}`);
        this.log('Fetching language: none');
        const none = await this.getDevicePoints(deviceList[i].data.deviceId, {}, 'none');
        this.log('Fetching language: no');
        const no = await this.getDevicePoints(deviceList[i].data.deviceId, {}, 'no');
        this.log('Fetching language: en');
        const en = await this.getDevicePoints(deviceList[i].data.deviceId, {}, 'en');
        this.log('Fetching language: sv');
        const sv = await this.getDevicePoints(deviceList[i].data.deviceId, {}, 'sv');
        this.log('Fetching language: de');
        const de = await this.getDevicePoints(deviceList[i].data.deviceId, {}, 'de');
        this.log('Fetching language: da');
        const da = await this.getDevicePoints(deviceList[i].data.deviceId, {}, 'da');
        this.log('Combining languages');
        deviceList[i].features = this.combineLanguages({
          none, en, no, sv, de, da
        });
      } catch (err) {
        this.log(`Error: ${err}`);
      }
    }
    console.log('WARNING: keys removed from this dump are: [timestamp]');
    console.log(JSON.stringify(deviceList, null, ''));
    this.homey.app.endDump();
  }

  async discoverDevices(driver) {
    // Fetch device definitions.
    const deviceFilesPath = `${await this.homey.app.getBasePath()}/drivers/${driver.id}/devices`;
    const deviceFiles = fs.readdirSync(deviceFilesPath);
    const validDevices = [];
    for (let i = 0; i < deviceFiles.length; i++) {
      const newDevice = JSON.parse(fs.readFileSync(`${deviceFilesPath}/${deviceFiles[i]}`));
      newDevice.filename = deviceFiles[i];
      validDevices.push(newDevice);
    }
    // Construct filters from the definitions.
    const filters = [];
    for (let i = 0; i < validDevices.length; i++) {
      let capabilities = Object
        .entries(validDevices[i].capTable)
        .map(([key, value]) => ({
          id: value,
          pointId: key,
          optional: validDevices[i].optionalPoints?.includes(key) ?? false
        }))

      const {
        name, filter, icon, driverId, filename, additional
      } = validDevices[i];
      filters.push({
        name, filter, icon, driverId, filename, additional, capabilities
      });
    }

    const filteredDevices = await this.discoverDevicesPrivate(filters);
    if (this.homey.app.startDump()) this.dumpAllState();
    return filteredDevices;
  }

  /* ************************************************************************** *
   *                             GETTER FUNCTIONS                               *
   * ************************************************************************** */

  async getSystems({ page }, language = 'en') {
    this.log('Get systems');
    return this.get({
      path: '/systems/me',
      headers: { 'Accept-Language': language },
      query: { page },
    });
  }

  async getDeviceFirmware(deviceId, language = 'en') {
    this.log('Get device firmware');
    return this.get({
      path: `/devices/${deviceId}/firmware-info`,
      headers: { 'Accept-Language': language }
    });
  }

  async getSmartHomeMode(systemId, language = 'en') {
    this.log('getSmartHomeMode');
    return this.get({
      path: `/systems/${systemId}/smart-home-mode`,
      headers: { 'Accept-Language': language },
      // query: { page },
    });
  }

  async getDeviceInfo(deviceId, language = 'en') {
    this.log('getDeviceInfo');
    return this.get({
      path: `/devices/${deviceId}`,
      headers: { 'Accept-Language': language },
      // query: { page },
    });
  }

  async getDevicePoints(deviceId, parameters, language = 'en') {
    // this.log(`getDevicePoints(${deviceId}, ${parameters})`);
    return this.get({
      path: `/devices/${deviceId}/points`,
      headers: { 'Accept-Language': language },
      query: {
        parameters: typeof parameters === 'string'
          ? parameters.split(',').filter(parameter => parameter.trim().length > 0).join(',')
          : parameters
      },
    })
      .then((gotValues) => {
        const promises = [];
        // In case a device has been attached, handle the retuned valued (otherwise, this function was called during pairing)
        if (Array.isArray(this.deviceMap[deviceId])) {
          // Go through all the values
          // eslint-disable-next-line no-restricted-syntax
          for (let idx = 0; idx < gotValues.length; idx++) {
            const key = gotValues[idx].parameterId;
            const { value, strVal } = gotValues[idx];
            const valueChanged = this.confirmedDevicePoints[deviceId][key] !== undefined
              && this.confirmedDevicePoints[deviceId][key] !== value;

            // Signal the devices
            if (valueChanged) {
              for (let instanceIdx = 0; instanceIdx < this.deviceMap[deviceId].length; instanceIdx++) {
                const instance = this.deviceMap[deviceId][instanceIdx];
                const { device } = this.devices[instance];
                if (!device.killed) {
                  promises.push(device.onDevicePointChanged(key, value, strVal));
                }
              }
            }

            this.confirmedDevicePoints[deviceId][key] = value;
            // Remove gotten values from pendingDevicePoints (if they match)
            if (key in this.pendingDevicePoints[deviceId]) {
              // eslint-disable-next-line eqeqeq
              if (value == this.pendingDevicePoints[deviceId][key]) {
                this.log(`Key ${key} confirmed ${value} = ${this.pendingDevicePoints[deviceId][key]}`);
                delete this.pendingDevicePoints[deviceId][key];
              } else {
                this.log(`Key ${key} not confirmed (set value: ${this.pendingDevicePoints[deviceId][key]}, actual: ${value}`);
              }
            }
          }
        }
        return Promise.all(promises)
          .then(() => Promise.resolve(gotValues));
      })
      .catch((err) => {
        this.log(`err ${err}`);
        const newErr = new Error(`Error reading ${JSON.stringify(parameters)}: ${err}`);
        return Promise.reject(newErr);
      }); // Pass on errors
  }

  async updateDevicePoint(devicePoint, newValue, instanceId) {
    const { device, deviceId, deviceDefinition } = this.devices[instanceId];

    await this.setDevicePoint(instanceId, { [devicePoint]: newValue });
    await this.getDevicePoints(deviceId, devicePoint);

    if (devicePoint in deviceDefinition.capTable)
    {
      await this.setCapability(deviceDefinition.capTable[devicePoint], newValue, device);
    }
    
    if (devicePoint in deviceDefinition.onChange)
    {
      await this.onValueUpdate(instanceId, devicePoint, newValue);
    }

    if (devicePoint in deviceDefinition.settingsTable)
    {
      await device.setSettings({
        [deviceDefinition.settingsTable[devicePoint]]: newValue
      });
    }

    // The line below updates variables from the device definition
    // that depend on the current time, or that should be updated
    // with any capability or setting change.
    // Examples of such capabilities for HOIAX driver are:
    // meter_power.leak_accum, measure_power.leak, measure_humidity.leak_relation.
    await this.onValueUpdate(instanceId, 'all');
  }

  async setCapability(name, value, device)
  {
    if (!device.hasCapability(name))
    {
      this.log(`Capability does not exist: ${name} = ${value}`);
      return;
    }

    this.log(`Setting capability: ${name} = ${value}`);
    const startName = name.substring(0, 5);

    if (startName === 'onoff' || startName === 'alarm') {
      await device.setCapabilityValue(name, +value ? true : false);
    } else if (name.substring(0, 9) === 'max_power') {
      await device.setCapabilityValue(name, String(value));
    } else {
      await device.setCapabilityValue(name, +value);
    }
  }

  async setDevicePoint(instanceId, parameters) {
    const { deviceId, deviceDefinition } = this.devices[instanceId];
    // eslint-disable-next-line no-restricted-syntax, guard-for-in
    for (const key in parameters) {
      const devPointDef = deviceDefinition.devPointTable[key];
      // Do not set parameters that are not defined:
      // These can come from common settings that are for similar devices, but not this one
      // (as the driver.settings.compose.json can not be updated runtime)
      if (devPointDef === undefined) {
        // delete parameters[key];
        // continue;
        return Promise.reject(new Error(`Setting ${key} is not available to be set on device ${deviceId}.`));
      }
      // Round values that require rounding
      if (devPointDef.type === TYPE.NUMBER) {
        parameters[key] = Math.floor(+parameters[key] / (+devPointDef.scaleValue * +devPointDef.stepValue)) * (+devPointDef.scaleValue * +devPointDef.stepValue);
      }
      // Do not set unchanged parameters
      if (key in this.confirmedDevicePoints[deviceId]
        && !(key in this.pendingDevicePoints[deviceId])
        // eslint-disable-next-line eqeqeq
        && parameters[key] == this.confirmedDevicePoints[deviceId][key]) {
        this.log(`Ignoring setting unchanged parameter ${key} to ${parameters[key]}}`);
        delete parameters[key];
      }
    }
    if (Object.keys(parameters).length === 0) {
      return true;
    }

    this.pendingDevicePoints[deviceId] = {
      ...this.pendingDevicePoints[deviceId],
      ...parameters
    };

    this.log(`Setting parameters: ${Object.keys(parameters)} to ${Object.values(parameters)}`);
    return this.patch({
      path: `/devices/${deviceId}/points`,
      json: parameters,
    })
      .then((res) => {
        this.log(`Set response: ${JSON.stringify(res)}`);
        return Promise.resolve(res);
      })
      .catch((err) => {
        const errorMessagePerCode = {
          '409': ' Please, check that the device has power and a network connection.',
          '403': ' Please, check user access and premium subscription if required.',
          '400': ' Please, verify setting values are valid.'
        };

        this.log(err);
        const errorText = `Failed to change the settings.${errorMessagePerCode[err.status] ?? ''}`;
        return Promise.reject(new Error(errorText));
      });
  }

  /**
   * Generates a list of values that are legal for a specific device point
   * during pairing the instanceId and devicePoint will be set to null and a custom list will be attached
   */
  async getDevicePointValues(instanceId, devicePoint, customList = undefined) {
    const devpointMap = (instanceId === null) ? null : this.devices[instanceId].deviceDefinition.devPointTable;
    const devicePointSettings = customList || devpointMap[devicePoint];

    if (devicePointSettings === undefined) return [];

    const results = [];
    const {
      type, enumValues, minValue, maxValue, stepValue, scaleValue, parameterUnit
    } = devicePointSettings;
    // eslint-disable-next-line no-nested-ternary
    let step = +stepValue;
    if ((maxValue - minValue) / step > 1000) {
      step = (maxValue - minValue) / 1000;
    }
    step = Math.ceil(step / +stepValue) * +stepValue;
    const numDecimals = (+scaleValue < 1) ? 1 : 0;
    switch (type) {
      case TYPE.ENUM:
        for (let i = 0; i < enumValues.length; i++) {
          const name = typeof enumValues[i].text === 'string' ? enumValues[i].text : this.homey.__(enumValues[i].text);
          results.push({ id: enumValues[i].value, name, description: '' });
        }
        break;
      case TYPE.NUMBER:
        for (let i = minValue; i <= maxValue; i += step) {
          const name = `${Number(i * +scaleValue).toFixed(numDecimals)} ${parameterUnit}`;
          results.push({ id: (i * +scaleValue), name, description: '' });
        }
        break;
      default:
        return [];
    }

    return results;
  }

  /**
   * Retrieve active alarms for specified system.
   * Optional ignored parameters are
   * page: default value is 1
   * itemsPerPage: default value is 10
   * Accept-Language: default value is en-US
   */
  async getActiveNotifications(systemId) {
    this.log('getActiveNotifications');
    return this.get({
      path: `/systems/${systemId}/notifications/active`
    });
  }

  /**
   * Retrieve all (active, inactive and archived) alarms for specified system.
   * Same parameters as getActiveNotification
   */
  async getNotifications(systemId) {
    this.log('getNotifications');
    return this.get({
      path: `/systems/${systemId}/notifications`
    });
  }

  /**
   * Synchronizes the states between the app and myUplink
   * The function is called once on app initialization, after that it will continue for
   * eternity keeping the state synched.
   */
  async synchronizeStates(instanceId) {
    const instance = this.devices[instanceId];
    // The watchdog in updateStatesRefreshTimeout can abandon this pass and start another.
    // Remember which pass this is so a superseded one cannot write back over its successor.
    const generation = instance.syncGeneration;
    let statesLeft = instance.statesLeft;
    const { deviceId, deviceDefinition, device, reverseKeyMap } = instance;
    let fetchStateError;
    this.devices[instanceId].updateID = undefined;
    this.log(`Fetching states for device ${deviceId}: ${JSON.stringify(statesLeft)}`);
    try {
      const stateToFetch = statesLeft.join(',');
      let stateRequest;
      try {
        if (statesLeft.length > 0) {
          stateRequest = await this.getDevicePoints(deviceId, stateToFetch);
        } else {
          stateRequest = []; // Avoid to fetch from myUplink if no state is requested
        }
        // this.log(`State response: ${JSON.stringify(stateRequest)}`);
      } catch (innerErr) {
        throw new Error(`Network problem: ${innerErr.message}`);
      }

      const fetchedStates = {}; // States going to settings
      if (Array.isArray(stateRequest)) {
        for (let val = 0; val < stateRequest.length; val++) {
          if ('parameterId' in stateRequest[val]) {
            const parameterId = stateRequest[val].parameterId;
            const { value, strVal } = POINT_UNDEFINED_VALUES.includes(stateRequest[val].value)
              ? { value: undefined, strVal: undefined }
              : stateRequest[val];

            if (!(parameterId in reverseKeyMap)) {
              // parameters in the keymap has actions to perform below. If it's not in the keymap it's used by flows only, so ignore
              if (!(parameterId in (this.doPrefetch[deviceId] || {}))) {
                // This is ok when the device driver is started, but it should not be recurrent.
                this.log(`WARNING: parameterId ${parameterId} fetched but is neither used by flows or present in device definition`);
              }
              continue;
            }
            const settingName = String(reverseKeyMap[parameterId].value);
            if (settingName.substring(0, 6) === 'status'
              || settingName.substring(0, 7) === 'setting') {
              if (instance.settingTypes[settingName] === 'number') {
                fetchedStates[settingName] = +value; // Value without unit
              } else if (instance.settingTypes[settingName] === 'dropdown') {
                fetchedStates[settingName] = `${value}`;
                // myUplink may contain invalid values, make sure that the value above was legal or remove it
                if (parameterId in deviceDefinition.devPointTable) {
                  const { enumValues } = deviceDefinition.devPointTable[parameterId];
                  if (Array.isArray(enumValues) && enumValues.length > 0) {
                    if (!(enumValues.map((a) => +a.value).includes(+value))) {
                      this.log(`WARNING: myUplink contains an invalid value ${value} for devicePoint ${parameterId} (device: ${deviceDefinition.name})`);
                      fetchedStates[settingName] = undefined;
                    }
                  }
                } else {
                  this.log(`WARNING: parameter ${parameterId} was read from myUplink but is not in the device definition for the device ${deviceDefinition.name}`);
                  this.log(`         The error occured while processing setting ${settingName}`);
                }
              } else {
                fetchedStates[settingName] = String(strVal || POINT_STRING_FALLBACK_VALUE); // Value with unit
              }
            } else if (parameterId in deviceDefinition.capTable) {
              this.setCapability(settingName, value, device);
            }
            // Update dependent values:
            await this.onValueUpdate(instanceId, parameterId, value);
          }
        }
      }
      await this.onValueUpdate(instanceId, 'all');

      // FW version need to be fetched separately, do this once every hour
      const now = Date.now();
      if (!instance.FwTime || (now - instance.FwTime > 3600000)) {
        instance.FwTime = now;
        fetchedStates.firmwareVersion = 'unknown';
        const firmwareResponse = await this.getDeviceInfo(deviceId);
        if (firmwareResponse && ('firmware' in firmwareResponse) && ('currentFwVersion' in firmwareResponse.firmware)) {
          fetchedStates.firmwareVersion = String(firmwareResponse.firmware.currentFwVersion);
          this.log(`Fetched FW version: ${fetchedStates.firmwareVersion}`);
        }
      }

      if (Object.keys(fetchedStates).length > 0) {
        try {
          const oldSettings = device.getSettings();

          // eslint-disable-next-line no-restricted-syntax, guard-for-in
          for (const name in fetchedStates) {
            if (typeof fetchedStates[name] !== typeof oldSettings[name]) {
              this.log(`Incorrect type of setting ${name}: New type: ${typeof fetchedStates[name]} Old type: ${typeof oldSettings[name]}`);
              delete fetchedStates[name];
            }
          }
          await device.setSettings(fetchedStates);
        } catch (innerErr) {
          // Nothing I possibly can do?
          //  - Disk full
          //  - State from myUplink is invalid
          this.log(`Could not save settings, will retry in a bit. ${innerErr}`);
        }
      }
      // Remove states from state requests:
      if (Array.isArray(stateRequest)) {
        const fetchedParams = stateRequest.map((item) => item.parameterId);
        statesLeft = statesLeft.filter((value) => !fetchedParams.includes(value));
      }
    } catch (err) {
      // Can be 'Network problem' or 'toSettings failed' (disk full?)
      fetchStateError = err;
      this.log(`Error: ${err}`);
    } finally {
      // executeWithTimeout only abandons the wait; it cannot stop this pass. If the
      // watchdog fired, a newer pass already owns the instance, so everything below -
      // setAvailable/setUnavailable, errCnt, the timeSince* counters, statesLeft and the
      // timer - would be applied from stale results. Bail before any of it.
      //
      // Returning from finally is safe here: the catch above swallows every error and
      // nothing in this function returns, so there is no pending completion to discard.
      // eslint-disable-next-line no-unsafe-finally
      if (instance.syncGeneration !== generation) {
        this.log(`Superseded polling pass for device ${deviceId} finished; discarding its result`);
        return;
      }

      let refreshRate = 60;
      // Before filtering the remaining states
      if (statesLeft.length > 0) {
        // Ignore states that are not always available (some device types have device points that are
        // missing when other device points have certain other values). If these device points failed,
        // remove them here to avoid reporting a failure and infinite retries. The device points may
        // still be retried later though when the refreshrate triggers.
        const unCommonTable = Array.isArray(deviceDefinition.unCommonTable) ? deviceDefinition.unCommonTable : [];
        this.log(`Could not fetch the following states: ${JSON.stringify(statesLeft)}, from which the following will be ignored: ${JSON.stringify(unCommonTable)}`);
        statesLeft = statesLeft.filter((value) => !unCommonTable.includes(+value));
      }
      // After states have been filtered
      if (statesLeft.length > 0) {
        // The device is still not initialized
        if (!fetchStateError) {
          // Note, this error may come in two circumstances:
          // 1) myUplink is temporary unavailable or cannot return certain device points for some other
          //    reason, this is ok and should make the device unavalable
          // 2) myUplink does not have all the device points available for the device in question, most
          //    probably as a result of the device configuration. If this is the case then the devicepoints
          //    should be listed in the deviceDefinition.unCommonTable array so it will be filtered out
          //    and as such prevent the device from becoming unavailable and prevent endless retries of
          //    fetching devicepoints that does not exist.
          fetchStateError = new Error(`Could not fetch all states: ${JSON.stringify(statesLeft)}; Please send a crash report to the developer so this can be investigated and fixed.`);
        }
        this.log(fetchStateError);
        if (!device.killed) {
          device.setUnavailable(this.isAuthorizationFailure(fetchStateError)
            ? new Error(`${fetchStateError.message} The myUplink authorization is no longer valid; please repair this device to sign in to myUplink again.`)
            : fetchStateError);
          // Retry this function again in a while
          instance.errCnt++;
          refreshRate = device.getSettings().updateRateErr * Math.min(instance.errCnt, 5);
        }
      } else {
        // All device points ok
        this.log('Device points refreshed');
        device.setAvailable();
        instance.errCnt = 0;
        const { updateRate, updateRateCache, updateRateSettings } = device.getSettings();
        refreshRate = Math.max(5, Math.min(
          updateRate - instance.timeSinceCapRefresh,
          updateRateCache - instance.timeSinceCacheRefresh,
          updateRateSettings - instance.timeSinceSettingsRefresh
        ));
        instance.timeSinceCapRefresh += refreshRate;
        instance.timeSinceCacheRefresh += refreshRate;
        instance.timeSinceSettingsRefresh += refreshRate;

        // Schedule next refresh of state
        if (instance.timeSinceCapRefresh >= updateRate) {
          instance.timeSinceCapRefresh = 0;
          // Currently, statesLeft includes all capabilities from the device definition, but it would be better
          // to include only those that are actually used by the device to avoid requesting the state for unused capabilities.
          statesLeft = statesLeft.concat(Object.keys(deviceDefinition.capTable || {}).filter((key) => key[0] !== '$'));
          statesLeft = statesLeft.concat(Object.keys(deviceDefinition.onChange || {}).filter((key) => (key[0] !== '$' && key !== 'all')));
        }
        if (instance.timeSinceCacheRefresh >= updateRateCache) {
          // Trigger onChanged for all flows in order for myUplink cache to evaluate which devicePoints that should
          // be fetched recurrently
          try {
            await instance.device.onDevicePointChanged('updateCache', 0, '');
          } catch (triggerErr) {
            this.error(`updateCache trigger failed for device ${deviceId}:`, triggerErr);
          }
          instance.timeSinceCacheRefresh = 0;
          statesLeft = statesLeft.concat(Object.keys(this.doPrefetch[deviceId] || {}));
        }
        if (instance.timeSinceSettingsRefresh >= updateRateSettings) {
          instance.timeSinceSettingsRefresh = 0;
          statesLeft = statesLeft.concat(Object.keys(deviceDefinition.settingsTable  || {}).filter((key) => key[0] !== '$'));
          statesLeft = statesLeft.concat(Object.keys(deviceDefinition.statusTable  || {}).filter((key) => key[0] !== '$'));
        }
      }
      // Remove duplicates created in the concats above
      statesLeft = [...new Set(statesLeft)];

      this.log(`States to be fetched: [${statesLeft}] in ${refreshRate} s`);
      this.devices[instanceId].statesLeft = [...new Set(statesLeft)];
      this.updateStatesRefreshTimeout(instanceId, refreshRate);
    }
  }

  updateStatesRefreshTimeout(instanceId, refreshRate)
  {
    const deviceMetadata = this.devices[instanceId];
    clearTimeout(deviceMetadata.updateID);
    deviceMetadata.updateID = setTimeout(async () => {
      if (deviceMetadata.device.killed) return;
      deviceMetadata.syncGeneration = (deviceMetadata.syncGeneration || 0) + 1;
      try {
        await this.executeWithTimeout(this.synchronizeStates, SYNC_WATCHDOG_MS, instanceId);
      } catch (error) {
        this.error(`Polling error for device ${deviceMetadata.deviceId}:`, error);
        // Reschedule after 60s so polling continues despite the transient error.
        this.updateStatesRefreshTimeout(instanceId, 60);
      }
    }, refreshRate * 1000);
  }

  async executeWithTimeout(func, timeoutMilliseconds, ...args) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Timed out after ${timeoutMilliseconds} ms.`)),
        timeoutMilliseconds,
      );
    });

    try {
      return await Promise.race([func.apply(this, args), timeoutPromise]);
    } finally {
      // Without this the timer keeps a handle alive for the full duration on every call.
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make sure that a specific devicePoint is prefethced from myUplink
   * Caching is done per deviceId
   */
  async qualifyCache(deviceId, devicePoint) {
    if (!(deviceId in this.doPrefetch)) {
      this.doPrefetch[deviceId] = {};
    }
    if (devicePoint in this.doPrefetch[deviceId]) {
      return Promise.resolve();
    }
    this.log(`Added device point ${devicePoint} to the cache for ${deviceId}`);
    this.doPrefetch[deviceId][devicePoint] = true;
    return this.getDevicePoints(deviceId, String(devicePoint));
  }

  async updateState(deviceId) {
    return Promise.resolve()
      .then(() => {

      })
      .then((response) => {
        if (response && response.ok) {
          this.setAvailable(); // pending State has been resolved
        }
        return Promise.resolve();
      })
      .catch((err) => {
        const newErr = new Error(`Network problem: ${err.message}`);
        this.setUnavailable(newErr);
        return Promise.reject(newErr);
      });
  }

  mapTable(table = {}, type) {
    const retVal = {};
    for (const key of Object.keys(table)) {
      if ((key[0] !== '$') && (key !== 'all')) { // Do not map variables
        const value = typeof table[key] === 'string' ? table[key] : 'variable';
        retVal[key] = { value, type };
      }
    }
    return retVal;
  }

  /**
   * Maps device points so they can be used by the flow cards.
   * Used by the generic driver only. (other devices pick this from the device definition)
   */
  mapDevPoints(devPoints) {
    const retval = {};
    for (let i = 0; i < devPoints.length; i++) {
      const { enumValues, value, parameterId } = devPoints[i];
      const type = (Number.isFinite(value) && enumValues.length === 0)
        ? TYPE.NUMBER : (Number.isFinite(value))
          ? TYPE.ENUM : TYPE.UNKNOWN;
      retval[parameterId] = {
        ...devPoints[i],
        type
      };
    }
    return retval;
  }

  /**
   * Initialize the device
   */
  async initDevice(device, deviceDefinition) {
    this.log(`Initializing device ${device.deviceId}`);
    // === Add device ===
    const { deviceId } = device;
    const newDevice = {
      device,
      deviceId,
      driverId: device.driver.id,
      deviceDefinition: { ...deviceDefinition },
      vars: {},             // Variables used by this instanceId
      keyMap: {},           // Filled with capabilities => myUplinkDevicePoints
      reverseKeyMap: {},    // Filled with myUplinkDevicePoints => capabilities
      errCnt: 0,
      timeSinceCapRefresh: 0,
      timeSinceCacheRefresh: 0,
      timeSinceSettingsRefresh: 0
    };
    this.devices.push(newDevice);
    if (!(deviceId in this.confirmedDevicePoints)) {
      this.confirmedDevicePoints[deviceId] = {};
      this.pendingDevicePoints[deviceId] = {};
    }

    // === Map device ===
    device.instanceId = this.devices.length - 1;
    const { instanceId } = device;
    if (!(deviceId in this.deviceMap)) {
      this.deviceMap[deviceId] = [];
    }
    this.deviceMap[deviceId].push(instanceId);
    if (this.deviceMap[deviceId].length > 1) {
      this.log(`WARNING: Device ${deviceId} is now controlled by ${this.deviceMap[deviceId].length} drivers`);
    }

    const definition = this.devices[instanceId].deviceDefinition;

    // === Generic drivers have no definition, need to generate one ===
    if (deviceDefinition.devPointTable === undefined) {
      this.log('Generic driver detected, added deviceDefinitions from myUplink (english only)');
      const devPoints = await this.getDevicePoints(deviceId, {}, 'en');
      definition.devPointTable = this.mapDevPoints(devPoints);
      definition.capTable = device.getStore().capTable;
      definition.onChange = device.getStore().onChange;
      definition.onCreated = device.getStore().onCreated;
      definition.onChange.all = {};
      device.deviceDefinition = definition;
    }

    // === Aquire the device states ===
    newDevice.doneInit = device.getStoreValue('doneInit') || false;
    newDevice.vars = device.getStoreValue('var') || {};
    this.log(`gotDoneInit: ${newDevice.doneInit}`);

    // === Prepare key maps ===
    this.log('Synchronizing states');
    newDevice.reverseKeyMap = {
      ...this.mapTable(definition.onChange, 'onChange'),
      ...this.mapTable(definition.capTable, 'cap'),
      ...this.mapTable(definition.settingsTable, 'settings'),
      ...this.mapTable(definition.statusTable, 'status'),
    };

    newDevice.keyMap = {};
    const keys = Object.keys({ ...this.mapTable(definition.capTable, 'cap') });
    for (let keyNr = 0; keyNr < keys.length; keyNr++) {
      newDevice.keyMap[newDevice.reverseKeyMap[keys[keyNr]].value] = keys[keyNr];
    }

    // === Find the setting types to be used in synchronizeStates ===
    // The setting types are found in the driver manifest
    const driverManifest = device.homey.manifest.drivers.filter((driver) => driver.id === newDevice.driverId)[0];
    const allSettings = [];
    for (let group = 0; group < driverManifest.settings.length; group++) {
      allSettings.push(...driverManifest.settings[group].children);
    }
    newDevice.settingTypes = {};
    for (let i = 0; i < allSettings.length; i++) {
      newDevice.settingTypes[allSettings[i].id] = allSettings[i].type;
    }

    // === Set all capability values and settings ===
    const settingPoints = Object
      .keys(newDevice.reverseKeyMap)
      .filter(key => !Object.hasOwn(definition.capTable, key));

    const statesLeft = device.getCapabilities()
      .map(capability => newDevice.keyMap[capability])
      .concat(settingPoints)
      .filter(state => state); // Remove null elements (stems from capabilites set by variables, not myuplink directly)

    if (!newDevice.doneInit) {
      const actionQueue = ('onCreated' in definition) ? Object.keys(definition.onCreated) : {};
      for (let i = 0; i < actionQueue.length; i++) {
        const key = actionQueue[i];
        let value = definition.onCreated[key];
        if (value === '#now') value = (new Date()).getTime();
        if (key[0] === '$') {
          newDevice.vars[key] = value;
        } else {
          const newState = {};
          newState[key] = value;
          try {
            await this.setDevicePoint(instanceId, newState);
          }
          catch (exception) {
            this.log(exception);
          }
        }
      }
      await device.setStoreValue('var', newDevice.vars);
    }

    newDevice.statesLeft = statesLeft;
    await this.synchronizeStates(instanceId);

    // === Add Capability listeners ===
    this.log('Adding capability listeners');
    await this.addCapListeners(device, definition.capTable);

    // === Finalizing init ===
    await device.setStoreValue('doneInit', true);
    this.log(`Device ${deviceId} fully initialized.`);
  }

  /**
   * Uninitialize an instance of a device
   */
  async unInitDevice(instanceId) {
    if (this.devices[instanceId].updateID) {
      clearTimeout(this.devices[instanceId].updateID);
      this.devices[instanceId].updateID = undefined;
    }
  }

  /**
   * Adds capability listeners for writeable devices
   */
  async addCapListeners(device, capLinks = {}) {
    const defaultWriteable = ['onoff', 'target_temperature'];
    const keys = Object.keys(capLinks);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const cap = capLinks[key];
      const mainCap = cap.split('.')[0];
      const isWriteable = defaultWriteable.includes(mainCap)
        || (Object.keys(device.homey.manifest.capabilities).includes(cap) && device.homey.manifest.capabilities[cap].setable);
      if (isWriteable) {
        device.registerCapabilityListener(cap, async (newVal) => {
          return this.onValueUpdate(device.instanceId, key, newVal, true)
            .then(() => this.onValueUpdate(device.instanceId, 'all', undefined, true));
        });
        this.log(`Added listener: ${cap}`);
      } else {
        this.log(`Skipped listener: ${cap}`);
      }
    }
    return Promise.resolve();
  }

  /**
   * Run whenever a value changed, this happens in 2 cases:
   * - When a user changed a capability value
   * - When reading a capability value from myUplink
   */
  async onValueUpdate(instanceId, key, newVal = undefined, fromCap = false) {
    const { deviceDefinition, device, deviceId, vars } = this.devices[instanceId];
    const stateToSet = {};
    let varUpdated = false;

    // 1) Update the value, either the variable or myUplink directly
    //    (if the source of the change is from myUplink then ignore)
    if (fromCap) {
      if (key[0] === '$') {
        // Update the variable
        vars[key] = newVal;
        varUpdated = true;
      } else if (key !== 'all') {
        // Update myUplink
        stateToSet[key] = +newVal; // Convert true/false to 1/0
      }
    }

    // 2) If there is a task-list, execute it:
    //    Both variables and other keys may have task lists
    const taskList =  deviceDefinition.onChange[key];
    if (taskList) {
      const taskKeys = Object.keys(taskList);
      for (let i = 0; i < taskKeys.length; i++) {
        const taskKey = taskKeys[i];
        let taskValue = taskList[taskKey];
        // Replace #now with the current time:
        taskValue = taskValue.replace('#now', (new Date()).getTime());
        // Replace all devicePoints:
        const deviceIdRegexp = /#([0-9]+)/g;
        let found = deviceIdRegexp.exec(taskValue);
        while (Array.isArray(found)) {
          const value = this.confirmedDevicePoints[deviceId][found[1]];
          taskValue = taskValue.replace(found[0], value);
          found = deviceIdRegexp.exec(taskValue);
        }
        // Replace all variables in the task
        // The longest variable names are replaced first in order to avoid leftover remains of variables starting with the same text
        const varKeys = Object.keys(vars);
        for (let varidx = varKeys.length - 1; varidx >= 0; varidx--) {
          taskValue = taskValue.replace(RegExp(`\\${varKeys[varidx]}`, 'g'), vars[varKeys[varidx]]);
        }
        // Evaluate all equations
        taskValue = evaluate(taskValue) || 0;
        if (taskKey[0] === '$') {
          // Update the variable
          const capName = deviceDefinition.capTable[taskKey];
          if (capName && (vars[taskKey] !== taskValue)) {
            await this.setCapability(capName, taskValue, device);
          }
          if (vars[taskKey] !== taskValue) {
            vars[taskKey] = taskValue;
            varUpdated = true;
          }
        } else {
          // Update myUplink
          stateToSet[taskKey] = taskValue;
        }
      }
    }

    if (varUpdated) await device.setStoreValue('var', vars);
    if (fromCap) await this.setDevicePoint(instanceId, stateToSet);
    return Promise.resolve();
  }

} // myUplinkOAuth2Client

module.exports = myUplinkOAuth2Client;
