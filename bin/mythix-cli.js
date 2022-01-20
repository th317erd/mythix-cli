#!/usr/bin/env node

const Path        = require('path');
const yargs       = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const SimpleYargs = require('simple-yargs');

function createYargsCommands(yargs, commandsObj, actionHandler) {
  var commands      = [];
  var commandNames  = Object.keys(commandsObj);

  for (var i = 0, il = commandNames.length; i < il; i++) {
    var commandName = commandNames[i];
    var Klass       = commandsObj[commandName];

    commands.push(Klass.commandString);
  }

  return SimpleYargs.buildCommands(yargs, actionHandler, commands, {
    actionHelper: function(commandName) {
      var Klass = commandsObj[commandName];
      return actionHandler.bind(Klass, commandName, Klass.path);
    }
  });
}

(async function() {
  const packageJSONPath = Path.resolve(__dirname, '..', 'package.json');
  const packageJSON     = require(packageJSONPath);

  var PWD = process.env.PWD;

  var mythixPath    = Path.dirname(require.resolve('mythix'));
  var mythixCLIPAth = Path.resolve(mythixPath, 'cli');
  var mythixCLI     = require(mythixCLIPAth);
  var config        = mythixCLI.loadMythixConfig(PWD);

  var Application = config.getApplicationClass(config);
  if (typeof Application !== 'function')
    throw new Error('Expected to find an Application class from "getApplicationClass", but none was returned.');

  var argv        = hideBin(process.argv).concat('');
  var rootCommand = yargs(argv);
  var application = await mythixCLI.createApplication(Application, { autoReload: false, database: false, httpServer: false });

  var commands = await mythixCLI.loadCommands(rootCommand, application);

  rootCommand = createYargsCommands(rootCommand, commands, async function(command, commandPath) {
    await mythixCLI.executeCommand(
      config.configPath,
      Path.dirname(require.resolve('yargs')),
      Path.dirname(require.resolve('simple-yargs', '..')),
      argv,
      commandPath,
      command,
    );

    await application.stop();
  });

  rootCommand.version(packageJSON.version).parse();
})();
