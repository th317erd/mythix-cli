#!/usr/bin/env node

const Path        = require('path');
const FileSystem  = require('fs');
const yargs       = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const SimpleYargs = require('simple-yargs');
const { spawn }   = require('child_process');

const {
  createHash,
  randomFillSync,
} = require('crypto');

function randomBytes(length) {
  var buffer = Buffer.alloc(length);
  randomFillSync(buffer);

  return buffer;
}

function SHA256(data) {
  var hash = createHash('sha256');
  hash.update(data);
  return hash.digest('hex');
}

function SHA512(data) {
  var hash = createHash('sha512');
  hash.update(data);
  return hash.digest('hex');
}

function randomHash(type = 'sha256', length = 128) {
  var bytes = randomBytes(length);
  var hash  = createHash(type);

  hash.update(bytes);

  return hash.digest('hex');
}

function walkDir(rootPath, _options, _callback, _allFiles, _depth) {
  var depth       = _depth || 0;
  var allFiles    = _allFiles || [];
  var callback    = (typeof _options === 'function') ? _options : _callback;
  var options     = (typeof _options !== 'function' && _options) ? _options : {};
  var filterFunc  = options.filter;
  var fileNames   = FileSystem.readdirSync(rootPath);

  for (var i = 0, il = fileNames.length; i < il; i++) {
    var fileName      = fileNames[i];
    var fullFileName  = Path.join(rootPath, fileName);
    var stats         = FileSystem.statSync(fullFileName);

    if (typeof filterFunc === 'function' && !filterFunc(fullFileName, fileName, stats, rootPath, depth))
      continue;
    else if (filterFunc instanceof RegExp && !filterFunc.match(fullFileName))
      continue;


    if (stats.isDirectory()) {
      walkDir(fullFileName, options, callback, allFiles, depth + 1);

      if (typeof callback === 'function')
        callback(fullFileName, fileName, rootPath, depth, stats);
    } else if (stats.isFile()) {
      if (typeof callback === 'function')
        callback(fullFileName, fileName, rootPath, depth, stats);

      allFiles.push(fullFileName);
    }
  }

  return allFiles;
}

function spawnProcess(name, args, options) {
  return new Promise((resolve, reject) => {
    try {
      var childProcess = spawn(
        name,
        args,
        Object.assign({}, options || {}, {
          env:    Object.assign({}, process.env, (options || {}).env || {}),
          stdio:  'inherit',
        })
      );

      childProcess.on('error', (error) => {
        reject(error);
      });

      childProcess.on('close', (code) => {
        if (code !== 0) {
          var error = new Error(`Process ${name} exited with non-zero code`);
          return reject(error);
        }

        resolve(code);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function createTemplateEngineContext(appName) {
  var context = Object.create(null);

  context.APP_NAME      = () => appName;
  context.RANDOM_SHA256 = () => randomHash('sha256');

  return context;
}

function getTemplatedFileName(fileName, context) {
  return fileName.replace(/__([A-Z0-9_]+)__/g, function(m, varName) {
    var func = context[varName];
    if (typeof func !== 'function')
      return '';

    return func();
  }).replace(/__/g, '');
}

function runTemplateOnFile(fullFileName, context) {
  var content = FileSystem.readFileSync(fullFileName, 'utf8');

  var newContent = content.replace(/<<<([A-Z0-9_]+)>>>/g, function(m, varName) {
    var func = context[varName];

    if (typeof func !== 'function')
      return '';

    return func();
  });

  if (newContent === content)
    return;

  FileSystem.writeFileSync(fullFileName, newContent, 'utf8');
}

function runTemplateEngineOnProject(projectPath, context) {
  walkDir(
    projectPath,
    {
      filter: (fullFileName, fileName, stats) => {
        if (fileName === 'node_modules' && stats.isDirectory())
          return false;

        return true;
      },
    },
    (_fullFileName, _fileName, rootPath, depth, stats) => {
      var fullFileName  = _fullFileName;
      var fileName      = _fileName;

      var newFileName = getTemplatedFileName(fileName, context);
      if (newFileName !== fileName) {
        fileName = newFileName;

        newFileName = Path.resolve(Path.dirname(fullFileName), newFileName);

        FileSystem.renameSync(fullFileName, newFileName)

        fullFileName = newFileName;
      }

      if (stats.isFile())
        runTemplateOnFile(fullFileName, context);
    }
  );
}

async function initApplication(_, args) {
  if (!args.dir || !('' + args.dir).match(/\S/))
    args.dir = Path.resolve(process.env.PWD);
  else
    args.dir = Path.resolve(args.dir);

  try {
    var templateClonePath = Path.resolve(args.dir, args.appName);
    var processArgs       = [ args.template, templateClonePath ];

    if (args.tag && args.tag.match(/\S/))
      processArgs = [ '-b', args.tag ].concat(processArgs);

    await spawnProcess('git', [ 'clone' ].concat(processArgs));

    FileSystem.rmSync(Path.resolve(templateClonePath, '.git'), { recursive: true, force: true });

    runTemplateEngineOnProject(templateClonePath, createTemplateEngineContext(args.appName));

    await spawnProcess('npm', [ 'i' ], { env: { PWD: templateClonePath, CWD: templateClonePath }, cwd: templateClonePath });
  } catch (error) {
    console.error('ERROR: ', error);
  }
}

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
    },
  });
}

(async function() {
  const packageJSONPath = Path.resolve(__dirname, '..', 'package.json');
  const packageJSON     = require(packageJSONPath);

  // Windows hack
  if(!process.env.PWD)
    process.env.PWD = process.cwd();

  var PWD = process.env.PWD;
  var argv = hideBin(process.argv);
  var rootCommand;

  try {
    if (argv[0] !== 'init') {
      argv        = hideBin(process.argv).concat('');
      rootCommand = yargs(argv);

      var mythixPath    = Path.dirname(require.resolve('mythix', { paths: [ process.env.PWD, Path.resolve(process.env.PWD, 'node_modules') ] }));
      var mythixCLIPAth = Path.resolve(mythixPath, 'cli');
      var mythixCLI     = require(mythixCLIPAth);
      var config        = mythixCLI.loadMythixConfig(PWD);

      var Application = config.getApplicationClass(config);
      if (typeof Application !== 'function')
        throw new Error('Expected to find an Application class from "getApplicationClass", but none was returned.');

      var application         = await mythixCLI.createApplication(Application, { autoReload: false, database: false, httpServer: false });
      var applicationOptions  = application.getOptions();

      var commands = await mythixCLI.loadCommands(applicationOptions.commandsPath);

      rootCommand = createYargsCommands(rootCommand, commands, async function(command, commandPath) {
        await mythixCLI.executeCommand(
          config.configPath,
          applicationOptions.commandsPath,
          Path.dirname(require.resolve('yargs')),
          Path.dirname(require.resolve('simple-yargs', '..')),
          argv,
          commandPath,
          command,
        );

        await application.stop();
      });
    } else {
      argv        = hideBin(process.argv);
      rootCommand = yargs(argv);
    }
  } catch (error) {
    console.error(mythixPath, error);
  }

  rootCommand = SimpleYargs.buildCommands(rootCommand, initApplication, [ 'init(Create a new application with the given name) <appName:string(Specify application name)> [-d,-dir:string(Path at which to create application)] [-t,-template:string(Git URL to use to clone and create new project from)=https://github.com/th317erd/mythix-app-template.git(Default "https://github.com/th317erd/mythix-app-template.git")] [-tag:string(Specify tag or commit hash to clone template from)]' ]);

  rootCommand.version(packageJSON.version).strictCommands().wrap(120).parse();
})();
