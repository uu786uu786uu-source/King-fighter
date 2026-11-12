#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packageJsonPath = require.resolve('react-native-callkeep/package.json');
const callKeepVersion = require(packageJsonPath).version;
const sourcePath = path.join(
  path.dirname(packageJsonPath),
  'android',
  'src',
  'main',
  'java',
  'io',
  'wazo',
  'callkeep',
  'RNCallKeepModule.java'
);

if (!fs.existsSync(sourcePath)) {
  throw new Error('RNCallKeep Android native module was not found: ' + sourcePath);
}

let source = fs.readFileSync(sourcePath, 'utf8');
const targets = ['displayIncomingCall', 'startCall'];
let removed = 0;

for (const method of targets) {
  // RNCallKeep used to export both 3- and 4-argument overloads to JavaScript.
  // React Native 0.76+ New Architecture rejects duplicate JS export names.
  // The public JS wrapper uses the 4-argument Android API, so the older
  // 3-argument Java bridge alias can safely be removed.
  const pattern = new RegExp(
    '^[\\t ]*@ReactMethod[\\t ]*\\r?\\n' +
    '[\\t ]*public void ' + method + '\\(String uuid, String number, String callerName\\) \\{\\r?\\n' +
    '[\\t ]*this\\.' + method + '\\(uuid, number, callerName, false, null\\);\\r?\\n' +
    '[\\t ]*\\}[\\t ]*\\r?\\n?',
    'm'
  );
  const patched = source.replace(pattern, '');
  if (patched !== source) {
    source = patched;
    removed += 1;
  }
}

for (const method of targets) {
  const legacy = new RegExp(
    '@ReactMethod\\s+public void ' + method + '\\(String uuid, String number, String callerName\\)'
  );
  const current = new RegExp(
    '@ReactMethod\\s+public void ' + method + '\\(String uuid, String number, String callerName, boolean hasVideo\\)',
    'g'
  );
  if (legacy.test(source)) {
    throw new Error('Unable to remove duplicate legacy RNCallKeep method: ' + method);
  }
  const count = [...source.matchAll(current)].length;
  if (count !== 1) {
    throw new Error('Expected exactly one annotated 4-argument ' + method + ' method, found ' + count);
  }
}

if (removed > 0) {
  fs.writeFileSync(sourcePath, source);
}
console.log('RNCallKeep ' + callKeepVersion + ': removed ' + removed + ' duplicate Android bridge alias(es); JavaScript call APIs retained.');
