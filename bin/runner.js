const Nife        = require('nife');
const Path        = require('path');
const FileSystem  = require('fs');
const { spawn }   = require('child_process');

const {
  CMDed,
  showHelp,
} = require('cmded');

const {
  createHash,
  randomFillSync,
} = require('crypto');

function randomBytes(length) {
  let buffer = Buffer.alloc(length);
  randomFillSync(buffer);

  return buffer;
}

function randomHash(type = 'sha256', length = 128) {
  let bytes = randomBytes(length);
  let hash  = createHash(type);

  hash.update(bytes);

  return hash.digest('hex');
}

function walkDir(rootPath, _options, _callback, _allFiles, _depth) {
  let depth       = _depth || 0;
  let allFiles    = _allFiles || [];
  let callback    = (typeof _options === 'function') ? _options : _callback;
  let options     = (typeof _options !== 'function' && _options) ? _options : {};
  let filterFunc  = options.filter;
  let fileNames   = FileSystem.readdirSync(rootPath);

  for (let i = 0, il = fileNames.length; i < il; i++) {
    let fileName      = fileNames[i];
    let fullFileName  = Path.join(rootPath, fileName);
    let stats         = FileSystem.statSync(fullFileName);

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
      let childProcess = spawn(
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
          let error = new Error(`Process ${name} exited with non-zero code`);
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
  let context = Object.create(null);

  context.APP_NAME      = () => appName;
  context.RANDOM_SHA256 = () => randomHash('sha256');

  return context;
}

function getTemplatedFileName(fileName, context) {
  return fileName.replace(/__([A-Z0-9_]+)__/g, function(m, varName) {
    let func = context[varName];
    if (typeof func !== 'function')
      return '';

    return func();
  }).replace(/__/g, '');
}

function runTemplateOnFile(fullFileName, context) {
  let content = FileSystem.readFileSync(fullFileName, 'utf8');

  let newContent = content.replace(/<<<([A-Z0-9_]+)>>>/g, function(m, varName) {
    let func = context[varName];

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
      let fullFileName  = _fullFileName;
      let fileName      = _fileName;

      let newFileName = getTemplatedFileName(fileName, context);
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

async function initApplication(args) {
  if (!args.dir || !('' + args.dir).match(/\S/))
    args.dir = Path.resolve(process.env.PWD);
  else
    args.dir = Path.resolve(args.dir);

  try {
    let templateClonePath = Path.resolve(args.dir, args.appName);
    let processArgs       = [ args.template, templateClonePath ];
    let tag;

    templateClonePath = templateClonePath.replace(/#([^#]+)$/, (m, hash) => {
      tag = hash;
      return '';
    });

    if (tag && tag.match(/\S/))
      processArgs = [ '-b', tag ].concat(processArgs);

    await spawnProcess('git', [ 'clone' ].concat(processArgs));

    FileSystem.rmSync(Path.resolve(templateClonePath, '.git'), { recursive: true, force: true });

    runTemplateEngineOnProject(templateClonePath, createTemplateEngineContext(args.appName));

    await spawnProcess('npm', [ 'i' ], { env: { PWD: templateClonePath, CWD: templateClonePath }, cwd: templateClonePath });

    console.log(`Empty mythix project created at ${templateClonePath}`);
    console.log('To finalize setup you need to:');
    console.log('  1) Select and configure the correct database driver for mythix-orm');
    console.log('  2) Define the models for your application');
    console.log('  3) Create an initial migration for your models: `npx mythix-cli makemigrations --name initial`');
    console.log('  4) Run migrations: `npx mythix-cli migrate`');
    console.log('  5) Finally run your application: `npx mythix-cli serve`');
  } catch (error) {
    console.error('ERROR: ', error);
    process.exit(1);
  }
}

function generateCommandHelp(commandsObj, globalHelp) {
  let commandNames = Object.keys(commandsObj || {});
  for (let i = 0, il = commandNames.length; i < il; i++) {
    let commandName = commandNames[i];
    let Klass       = commandsObj[commandName];
    let help        = null;

    if (typeof Klass.commandArguments === 'function') {
      let result = (Klass.commandArguments() || {});
      help = result.help;
    }

    if (!help) {
      help = {
        '@usage': `mythix-cli ${commandName}`,
        '@title': `Invoke the "${commandName}" command`,
        '@see':   `See: 'mythix-cli test --help' for more help`,
      };
    }

    if (!help['@see'])
      help['@see'] = `See: 'mythix-cli ${commandName} --help' for more help`;

    globalHelp[commandName] = help;
  }
}

function commandRunners(commandsObj, context, showHelp) {
  let commandNames = Object.keys(commandsObj);

  for (let i = 0, il = commandNames.length; i < il; i++) {
    let commandName = commandNames[i];
    let Klass       = commandsObj[commandName];
    let runner      = null;

    if (typeof Klass.commandArguments === 'function') {
      let result = (Klass.commandArguments() || {});
      runner = result.runner;
    }

    let result = context.match(commandName, ({ scope, store, fetch }, parserResult) => {
      store({ command: commandName });

      return scope(commandName, (context) => {
        if (typeof runner === 'function') {
          let runnerResult = runner(context, parserResult);
          if (!runnerResult) {
            showHelp(commandName);
            return false;
          }
        }

        if (fetch('help', false)) {
          showHelp(commandName);
          return false;
        }

        return true;
      });
    });

    if (result)
      return true;
  }

  return false;
}

(async function() {
  const packageJSONPath = Path.resolve(__dirname, '..', 'package.json');
  const packageJSON     = require(packageJSONPath);

  // Windows hack
  if(!process.env.PWD)
    process.env.PWD = process.cwd();

  let argOptions = CMDed(({ $, store, Types }) => {
    $('--config', Types.STRING({
      format: Path.resolve,
    })) || store({ config: (Nife.isNotEmpty(process.env.MYTHIX_CONFIG_PATH)) ? Path.resolve(process.env.MYTHIX_CONFIG_PATH) : Path.join(process.env.PWD, '.mythix-config.js') });

    $('--runtime', Types.STRING());

    $('-e', Types.STRING(), { name: 'environment' });
    $('--env', Types.STRING(), { name: 'environment' });

    $('--version', Types.BOOLEAN());

    $('--help', Types.BOOLEAN());

    // Consume to VOID
    $('--', () => {});

    $('init', ({ scope }) => {
      return scope('init', ({ $ }) => {
        $('--dir', Types.STRING({ format: Path.resolve }), { name: 'dir' })
          || $('-d', Types.STRING({ format: Path.resolve }), { name: 'dir' })
          || store({ dir: Path.resolve('./') });

        $('--template', Types.STRING(), { name: 'template' })
          || $('-t', Types.STRING(), { name: 'template' })
          || store({ template: 'https://github.com/th317erd/mythix-app-template.git' });

        return $(/^([\w](?:[\w-]+)?)$/, ({ store }, parserResult) => {
          store({ name: parserResult.name });
          return true;
        }, {
          formatParserResult: (value) => {
            return { name: value[1] };
          },
        });
      });
    });

    return true;
  }, { helpArgPattern: null });

  if (argOptions.version) {
    console.log(packageJSON.version);
    return process.exit(0);
  }

  let help = {
    '@usage': 'mythix-cli [command] [options]',
    '@title': 'Run a CLI command',
    '--config={config file path} | --config {config file path}': 'Specify the path to ".mythix-config.js". Default = "{CWD}/.mythix-config.js".',
    '-e={environment} | -e {environment} | --env={environment} | --env {environment}': 'Specify the default environment to use. Default = "development".',
    '--runtime={runtime} | --runtime {runtime}': 'Specify the runtime to use to launch the command. Default = "node"',
    'init': {
      '@usage': 'mythix-cli init app-name [options]',
      '@title': 'Initialize a blank mythix application',
      '@see': 'See: \'mythix-cli init --help\' for more help',
      '-d={path} | -d {path} | --dir={path} | --dir {path}': 'Specify directory to create new application in. Default = "./"',
      '-t={url} | -t {url} | --template={url} | --template {url}': 'Specify a git repository URL to use for a template to create the application with. Default = "https://github.com/th317erd/mythix-app-template.git".'
    },
  };

  if (argOptions.init) {
    if (Nife.isEmpty(argOptions.init)) {
      showHelp(help.init);
      return process.exit(1);
    }

    await initApplication(argOptions.init);

    return;
  }

  try {
    let helpShown = false;

    const customShowHelp = (scope) => {
      if (helpShown)
        return;

      helpShown = true;

      showHelp(help[scope] || help)
    };

    let rootOptions   = { help, showHelp: customShowHelp, helpArgPattern: null };
    let mythixPath    = Path.dirname(require.resolve('mythix', { paths: [ process.env.PWD, Path.resolve(process.env.PWD, 'node_modules') ] }));
    let mythixCLIPAth = Path.resolve(mythixPath, 'cli');
    let mythixCLI     = require(mythixCLIPAth);
    let config        = mythixCLI.loadMythixConfig(argOptions.config);

    let Application = config.getApplicationClass(config);
    if (typeof Application !== 'function')
      throw new Error('Expected to find an Application class from "getApplicationClass", but none was returned.');

    let application         = await mythixCLI.createApplication(Application, { autoReload: false, database: false, httpServer: false });
    let applicationOptions  = application.getOptions();

    let commands = await mythixCLI.loadCommands(applicationOptions.commandsPath);
    generateCommandHelp(commands, help);

    let commandContext = CMDed((context) => {
      let { $, Types, store } = context;

      $('--config', Types.STRING({
        format: Path.resolve,
      })) || store({ config: (Nife.isNotEmpty(process.env.MYTHIX_CONFIG_PATH)) ? Path.resolve(process.env.MYTHIX_CONFIG_PATH) : Path.join(process.env.PWD, '.mythix-config.js') });

      $('--runtime', Types.STRING());

      $('-e', Types.STRING(), { name: 'environment' });
      $('--env', Types.STRING(), { name: 'environment' });

      $('--help', Types.BOOLEAN());

      return commandRunners(commands, context, customShowHelp);
    }, rootOptions);

    if (!commandContext) {
      customShowHelp();
      return process.exit(1);
    }

    await mythixCLI.executeCommand(
      config,
      applicationOptions,
      commandContext,
      commands[commandContext.command],
      process.argv.slice(2),
    );

    await application.stop();
  } catch (error) {
    console.error(error);
  }
  // rootCommand = SimpleYargs.buildCommands(rootCommand, initApplication, [ 'init(Create a new application with the given name) <appName:string(Specify application name)> [-d,-dir:string(Path at which to create application)] [-t,-template:string(Git URL to use to clone and create new project from)=https://github.com/th317erd/mythix-app-template.git(Default "https://github.com/th317erd/mythix-app-template.git")] [-tag:string(Specify tag or commit hash to clone template from)]' ]);

  // rootCommand.version(packageJSON.version).strictCommands().wrap(120).parse();
})();
