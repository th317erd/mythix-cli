#!/usr/bin/env node

const Path      = require('path');
const {
  Command,
} = require('commander');

(async function() {
  const packageJSONPath = Path.resolve(__dirname, '..', 'package.json');
  const packageJSON     = require(packageJSONPath);

  const program = new Command();
  program.version(packageJSON.version);

  const entryPath = Path.resolve(__dirname, '..', 'src', 'index.js');
  await require(entryPath)(options);
})();
