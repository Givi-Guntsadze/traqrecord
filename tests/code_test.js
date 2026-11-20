const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');

const VALID_TOKEN = 'a'.repeat(64);
const UNKNOWN_TOKEN = 'c'.repeat(64);
const INACTIVE_TOKEN = 'b'.repeat(64);
const CONFIGURED_TOKEN = 'd'.repeat(64);
const INTO_TOKEN = '1'.repeat(64);
const GEDU_TOKEN = '2'.repeat(64);
const BURGSB_TOKEN = '3'.repeat(64);
const SCAN_SPREADSHEET_ID = '1FairScanWorkbookIdForAuthorizationTests';

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

class FakeRange {
  constructor(sheet, row, column, numRows = 1, numColumns = 1) {
    this.sheet = sheet;
    this.row = row;
    this.column = column;
    this.numRows = numRows;
    this.numColumns = numColumns;
  }

  getValues() {
    // row 1 is always a one-row header check (requireSheetWithHeaders);
    // row 2+ is always a real data read (readDataRows). Tracking them
    // separately lets tests measure the expensive part in isolation from
    // the constant, cheap per-request header check.
    this.sheet.recordRead(this.numRows, this.row === 1);
    return Array.from({ length: this.numRows }, (_, rowOffset) =>
      Array.from({ length: this.numColumns }, (_, columnOffset) =>
        this.sheet.rows[this.row - 1 + rowOffset]?.[this.column - 1 + columnOffset] ?? ''
      )
    );
  }

  setValues(values) {
    if (this.sheet.failNextWrite) {
      this.sheet.failNextWrite = false;
      throw new Error('Simulated Sheets write failure');
    }
    this.sheet.recordWrite(this.numRows);
    for (let rowOffset = 0; rowOffset < this.numRows; rowOffset += 1) {
      for (let columnOffset = 0; columnOffset < this.numColumns; columnOffset += 1) {
        this.sheet.setCell(
          this.row + rowOffset,
          this.column + columnOffset,
          values[rowOffset][columnOffset]
        );
      }
    }
    return this;
  }

  setValue(value) {
    this.sheet.setCell(this.row, this.column, value);
    return this;
  }

  getValue() {
    return this.getValues()[0][0];
  }

  setFontWeight() {
    return this;
  }

  getRow() {
    return this.row;
  }

  getNumRows() {
    return this.numRows;
  }
}

class FakeSheet {
  constructor(name, rows = [], stats) {
    this.name = name;
    this.rows = rows.map(row => [...row]);
    this.stats = stats;
    this.failNextWrite = false;
  }

  recordRead(numRows, isHeaderCheck) {
    if (!this.stats) return;
    this.stats.readCalls[this.name] = (this.stats.readCalls[this.name] || 0) + 1;
    this.stats.readRows[this.name] = (this.stats.readRows[this.name] || 0) + numRows;
    if (!isHeaderCheck) {
      this.stats.dataReadCalls[this.name] = (this.stats.dataReadCalls[this.name] || 0) + 1;
      this.stats.dataReadRows[this.name] = (this.stats.dataReadRows[this.name] || 0) + numRows;
    }
  }

  recordWrite(numRows) {
    if (!this.stats) return;
    this.stats.writeCalls[this.name] = (this.stats.writeCalls[this.name] || 0) + 1;
    this.stats.writeRows[this.name] = (this.stats.writeRows[this.name] || 0) + numRows;
  }

  getName() {
    return this.name;
  }

  getLastRow() {
    return this.rows.length;
  }

  getLastColumn() {
    return this.rows.reduce((max, row) => Math.max(max, row.length), 0);
  }

  getRange(row, column, numRows = 1, numColumns = 1) {
    return new FakeRange(this, row, column, numRows, numColumns);
  }

  appendRow(row) {
    this.recordWrite(1);
    this.rows.push([...row]);
    return this;
  }

  setCell(row, column, value) {
    while (this.rows.length < row) this.rows.push([]);
    while (this.rows[row - 1].length < column) this.rows[row - 1].push('');
    this.rows[row - 1][column - 1] = value;
  }
}

class FakeSpreadsheet {
  constructor(sheetDefinitions) {
    this.stats = {
      readCalls: {},
      readRows: {},
      dataReadCalls: {},
      dataReadRows: {},
      writeCalls: {},
      writeRows: {}
    };
    this.sheets = new Map(
      Object.entries(sheetDefinitions).map(([name, rows]) => [name, new FakeSheet(name, rows, this.stats)])
    );
  }

  getSheetByName(name) {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name) {
    const sheet = new FakeSheet(name, [], this.stats);
    this.sheets.set(name, sheet);
    return sheet;
  }

  getId() {
    return SCAN_SPREADSHEET_ID;
  }
}

class FakeCache {
  constructor() {
    this.store = new Map();
  }

  get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }

  put(key, value) {
    // TTL is intentionally ignored here: tests simulate "the TTL elapsed"
    // by explicitly calling remove()/clear() rather than by waiting, since
    // this is a fake, in-process cache with no real clock.
    this.store.set(key, String(value));
  }

  remove(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

function defaultSheets() {
  return {
    Raw_Scans: [
      ['Timestamp', 'Uni_ID', 'UUID']
    ],
    participant_url: [
      ['Participant_Name', 'Participant_ID', 'Token_Hash', 'Active', 'Scanner_URL'],
      [
        'Constructor University',
        'constructor',
        sha256(VALID_TOKEN),
        true,
        `https://scanner.example/?uni=constructor#token=${VALID_TOKEN}`
      ],
      [
        'Inactive University',
        'inactive',
        sha256(INACTIVE_TOKEN),
        false,
        `https://scanner.example/?uni=inactive#token=${INACTIVE_TOKEN}`
      ],
      [
        'IE University',
        'ieu',
        sha256(CONFIGURED_TOKEN),
        true,
        `https://scanner.example/?uni=ieu#token=${CONFIGURED_TOKEN}`
      ],
      [
        'INTO',
        'into',
        sha256(INTO_TOKEN),
        true,
        `https://scanner.example/?uni=into#token=${INTO_TOKEN}`
      ],
      [
        'GEDU',
        'gedu',
        sha256(GEDU_TOKEN),
        true,
        `https://scanner.example/?uni=gedu#token=${GEDU_TOKEN}`
      ],
      [
        'Burgundy School of Business',
        'burgsb',
        sha256(BURGSB_TOKEN),
        true,
        `https://scanner.example/?uni=burgsb#token=${BURGSB_TOKEN}`
      ]
    ],
    valid_tickets: [
      ['UUID'],
      ['A1B2C3D4'],
      ['12345678'],
      ['CAMP0001'],
      ['CAMP0002'],
      ['CAMP0003'],
      ['CAMP0004'],
      ['CAMP0005']
    ]
  };
}

function createEnvironment(
  sheetDefinitions = defaultSheets(),
  {
    activeSpreadsheetAvailable = true,
    configuredSpreadsheetId = SCAN_SPREADSHEET_ID,
    lockContended = false
  } = {}
) {
  const spreadsheet = new FakeSpreadsheet(sheetDefinitions);
  let lockReleases = 0;
  const lockEvents = [];
  const loggedErrors = [];
  const loggedWarnings = [];
  const loggedInfo = [];
  const openedSpreadsheetIds = [];
  const scriptProperties = new Map();
  const cache = new FakeCache();
  if (configuredSpreadsheetId) {
    scriptProperties.set('SCAN_SPREADSHEET_ID', configuredSpreadsheetId);
  }
  const context = {
    console: {
      error(message) { loggedErrors.push(String(message)); },
      warn(message) { loggedWarnings.push(String(message)); },
      log(message) { loggedInfo.push(String(message)); }
    },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput(text) {
        return {
          text,
          setMimeType() { return this; }
        };
      }
    },
    CacheService: {
      getScriptCache() { return cache; }
    },
    LockService: {
      getScriptLock() {
        return {
          waitLock() {
            if (lockContended) {
              throw new Error('Could not obtain lock');
            }
          },
          releaseLock() {
            lockReleases += 1;
            lockEvents.push('release');
          }
        };
      }
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => activeSpreadsheetAvailable ? spreadsheet : null,
      flush() { lockEvents.push('flush'); },
      openById(id) {
        openedSpreadsheetIds.push(id);
        if (id !== SCAN_SPREADSHEET_ID) throw new Error('Unexpected spreadsheet ID');
        return spreadsheet;
      }
    },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty: key => scriptProperties.get(key) ?? null,
          setProperty(key, value) {
            scriptProperties.set(key, value);
          }
        };
      }
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' },
      Charset: { UTF_8: 'UTF_8' },
      computeDigest(algorithm, value) {
        assert.equal(algorithm, 'SHA_256');
        return [...crypto.createHash('sha256').update(value, 'utf8').digest()]
          .map(byte => byte > 127 ? byte - 256 : byte);
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(fs.readFileSync('Code.gs', 'utf8'), context, { filename: 'Code.gs' });
  return {
    context,
    spreadsheet,
    cache,
    loggedErrors,
    loggedWarnings,
    loggedInfo,
    openedSpreadsheetIds,
    scriptProperties,
    stats: spreadsheet.stats,
    lockReleases: () => lockReleases,
    lockEvents: () => [...lockEvents]
  };
}

function parseResponse(output) {
  return JSON.parse(output.text);
}

function postRequest(context, {
  participantId = 'constructor',
  token = VALID_TOKEN,
  uuid = 'A1B2C3D4',
  timestamp = '2026-07-27T12:00:00.000Z',
  campus
} = {}) {
  const parameter = { participant_id: participantId, token, uuid, timestamp };
  if (campus !== undefined) {
    parameter.campus = campus;
  }
  return parseResponse(context.doPost({
    parameter,
    postData: {
      type: 'application/x-www-form-urlencoded',
      contents: new URLSearchParams(parameter).toString()
    }
  }));
}

let clientIdCounter = 0;

function scanInput(overrides = {}) {
  clientIdCounter += 1;
  return {
    client_id: overrides.clientId ?? `client-${clientIdCounter}`,
    participant_id: overrides.participantId ?? 'constructor',
    token: overrides.token ?? VALID_TOKEN,
    uuid: overrides.uuid ?? 'A1B2C3D4',
    timestamp: overrides.timestamp ?? '2026-07-27T12:00:00.000Z',
    campus: overrides.campus
  };
}

function postBatch(context, overridesList) {
  const scans = overridesList.map(scanInput);
  const response = parseResponse(context.doPost({
    parameter: {},
    postData: {
      type: 'application/json',
      contents: JSON.stringify({ scans })
    }
  }));
  return { results: response.results, scans };
}

function resultFor(batchResult, clientId) {
  return batchResult.results.find(result => result.client_id === clientId);
}

{
  const { context, spreadsheet, lockReleases, lockEvents, loggedInfo } = createEnvironment();
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');

  assert.deepEqual(parseResponse(context.doGet({ parameter: {} })), {
    result: 'error',
    code: 'method_not_allowed'
  });
  assert.equal(rawScans.getLastRow(), 1, 'GET must never append a scan');

  assert.deepEqual(postRequest(context), {
    result: 'success',
    duplicate: false
  });
  assert.equal(rawScans.getLastRow(), 2);
  assert.equal(rawScans.rows[1][1], 'constructor');
  assert.equal(rawScans.rows[1][2], 'A1B2C3D4');
  assert.equal(rawScans.rows[1].length, 3);
  assert.equal(lockReleases(), 1);
  assert.deepEqual(
    lockEvents(),
    ['flush', 'release'],
    'pending spreadsheet writes must flush before releasing the script lock'
  );
  assert.equal(loggedInfo.length, 0, 'a first-time accepted scan is not a duplicate event');

  assert.deepEqual(postRequest(context), {
    result: 'success',
    duplicate: true
  });
  assert.equal(rawScans.getLastRow(), 2, 'duplicate scans must not append');
  // A cache-confirmed duplicate is resolved before the lock is ever taken,
  // so lockReleases must NOT increase again here: this is the point of the
  // high-volume optimization (duplicates cost zero lock contention).
  assert.equal(lockReleases(), 1, 'a cache-confirmed duplicate must not acquire the lock at all');
  assert.deepEqual(lockEvents(), ['flush', 'release']);
  assert.equal(loggedInfo.length, 1, 'a duplicate scan logs one informational event');
  const duplicateEvent = JSON.parse(loggedInfo[0]);
  assert.equal(duplicateEvent.event, 'scan_duplicate');
  assert.equal(duplicateEvent.participantId, 'constructor');
  assert.equal(duplicateEvent.uuid, 'A1B2C3D4');
  assert.doesNotMatch(loggedInfo[0], new RegExp(VALID_TOKEN));
}

for (const [label, request, expectedCode] of [
  ['mismatched participant ID', { participantId: 'ie' }, 'unauthorized'],
  ['unknown token', { token: UNKNOWN_TOKEN }, 'unauthorized'],
  ['inactive participant', { participantId: 'inactive', token: INACTIVE_TOKEN }, 'unauthorized'],
  ['unknown ticket', { uuid: 'ZZZZZZZZ' }, 'invalid_ticket'],
  ['short token', { token: 'abc' }, 'invalid_request'],
  ['lowercase ticket', { uuid: 'a1b2c3d4' }, 'invalid_request'],
  ['formula participant', { participantId: '=IMPORTDATA' }, 'invalid_request'],
  ['invalid timestamp', { timestamp: 'not-a-date' }, 'invalid_request'],
]) {
  const { context, spreadsheet, loggedWarnings, loggedErrors } = createEnvironment();
  const response = postRequest(context, request);
  assert.equal(response.result, 'error', label);
  assert.equal(response.code, expectedCode, label);
  assert.equal(
    spreadsheet.getSheetByName('Raw_Scans').getLastRow(),
    1,
    `${label} must not append`
  );
  assert.doesNotMatch(JSON.stringify(response), new RegExp(request.token ?? VALID_TOKEN));

  assert.equal(loggedWarnings.length, 1, `${label} must log exactly one diagnostic warning`);
  assert.equal(loggedErrors.length, 0, `${label} is an expected rejection, not a server error`);
  const logged = JSON.parse(loggedWarnings[0]);
  assert.equal(logged.event, 'scan_rejected', label);
  assert.equal(logged.code, expectedCode, label);
  assert.doesNotMatch(loggedWarnings[0], new RegExp(request.token ?? VALID_TOKEN), `${label} must never log the token`);
  assert.doesNotMatch(loggedWarnings[0], new RegExp(sha256(request.token ?? VALID_TOKEN)), `${label} must never log a token hash`);
}

{
  const sheets = defaultSheets();
  delete sheets.valid_tickets;
  const { context, loggedErrors, loggedWarnings } = createEnvironment(sheets);
  const response = postRequest(context);
  assert.deepEqual(response, { result: 'error', code: 'server_error' });
  assert.equal(loggedErrors.length, 1);
  assert.equal(loggedWarnings.length, 0, 'a server exception is not an expected rejection');
  assert.doesNotMatch(JSON.stringify(response), new RegExp(VALID_TOKEN));

  const logged = JSON.parse(loggedErrors[0]);
  assert.equal(logged.event, 'scan_error');
  assert.equal(logged.code, 'server_error');
  assert.equal(logged.participantId, 'constructor');
  assert.equal(logged.uuid, 'A1B2C3D4');
  assert.match(logged.message, /Missing required scanner sheet: valid_tickets/);
  assert.doesNotMatch(loggedErrors[0], new RegExp(VALID_TOKEN), 'server error log must never contain the token');
}

{
  // Lock contention is transient and must be diagnosable without ever
  // logging the credential that authorized the request.
  const { context, spreadsheet, loggedWarnings, loggedErrors } = createEnvironment(
    defaultSheets(),
    { lockContended: true }
  );
  const response = postRequest(context);
  assert.deepEqual(response, { result: 'error', code: 'server_busy' });
  assert.equal(spreadsheet.getSheetByName('Raw_Scans').getLastRow(), 1);
  assert.equal(loggedErrors.length, 0, 'lock contention is expected, not a server exception');
  assert.equal(loggedWarnings.length, 1);

  const logged = JSON.parse(loggedWarnings[0]);
  assert.equal(logged.event, 'scan_rejected');
  assert.equal(logged.code, 'server_busy');
  assert.equal(logged.participantId, 'constructor');
  assert.equal(logged.uuid, 'A1B2C3D4');
  assert.doesNotMatch(loggedWarnings[0], new RegExp(VALID_TOKEN));
}

{
  const { context, spreadsheet } = createEnvironment();
  const rawScans = spreadsheet.getSheetByName('Raw_Scans');
  rawScans.failNextWrite = true;
  const failed = postBatch(context, [{}, {}]);
  for (const scan of failed.scans) {
    assert.equal(resultFor(failed, scan.client_id).code, 'server_error');
  }
  assert.equal(rawScans.getLastRow(), 1);

  const retried = postBatch(context, [{}, {}]);
  assert.equal(rawScans.getLastRow(), 2);
  assert.equal(retried.results.filter(item => item.result === 'success').length, 2);
  assert.equal(retried.results.filter(item => item.duplicate === true).length, 1);
}

{
  const { context, spreadsheet } = createEnvironment();
  const result = parseResponse(context.doPost({
    parameter: {
      participant_id: 'constructor',
      token: VALID_TOKEN,
      uuid: 'A1B2C3D4',
      timestamp: '2026-07-27T12:00:00.000Z'
    },
    postData: { type: 'application/x-www-form-urlencoded', contents: 'unused=1' }
  }));
  assert.equal(result.code, 'invalid_request');
  assert.equal(spreadsheet.getSheetByName('Raw_Scans').getLastRow(), 1);
}
