import Path               from 'node:path';
import FileSystem         from 'node:fs';
import { spawn }          from 'node:child_process';
import { fileURLToPath }  from 'node:url';
import { createRequire }  from 'node:module';
import Nife               from 'nife';

const require     = createRequire(import.meta.url);
const __filename  = fileURLToPath(import.meta.url);
const __dirname   = Path.dirname(__filename);

import {
  CMDed,
  showHelp,
} from 'cmded';

import {
  createHash,
  randomFillSync,
} from 'node:crypto';

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

function getFormattedAppName(appName) {
  return appName.trim().replace(/[^\w-]+/g, '-').replace(/^[^a-zA-Z0-9]+/g, '').replace(/[^a-zA-Z0-9]+$/g, '').toLowerCase();
}

function getFormattedAppDisplayName(appName) {
  return Nife.capitalize(getFormattedAppName(appName).replace(/[^a-zA-Z0-9]+/g, ' ').trim(), true);
}

function resolveJavascriptFileName(filePathWithoutExtension) {
  if (FileSystem.existsSync(filePathWithoutExtension)) {
    let stats = FileSystem.statSync(filePathWithoutExtension);
    if (stats.isDirectory())
      return resolveJavascriptFileName(`${filePathWithoutExtension}/index`);

    return filePathWithoutExtension;
  }

  let filePath = `${filePathWithoutExtension}.mjs`;
  if (FileSystem.existsSync(filePath))
    return filePath;

  filePath = `${filePathWithoutExtension}.cjs`;
  if (FileSystem.existsSync(filePath))
    return filePath;

  filePath = `${filePathWithoutExtension}.js`;
  if (FileSystem.existsSync(filePath))
    return filePath;
}

async function createTemplateEngineContext(templateClonePath, _appName) {
  let context         = Object.create(null);
  let appName         = getFormattedAppName(_appName);
  let appDisplayName  = getFormattedAppDisplayName(_appName);

  context.APP_NAME          = () => appName;
  context.APP_DISPLAY_NAME  = () => appDisplayName;
  context.RANDOM_SHA256     = () => randomHash('sha256');

  try {
    let helpersPath     = resolveJavascriptFileName(Path.join(templateClonePath, 'mythix-cli-template-helpers'));
    let projectHelpers  = await import(helpersPath);
    if (projectHelpers && projectHelpers.default)
      projectHelpers = projectHelpers.default;

    context = Object.assign({}, projectHelpers, context);

    FileSystem.unlinkSync(helpersPath);
  } catch (error) {
    console.error('Unable to import helpers: ', error);
  }

  return context;
}

function getTemplatedFileName(fileName, context) {
  return fileName.replace(/\b__([A-Z0-9_-]+)__\b/g, function(m, varName) {
    let func = context[varName];
    if (typeof func !== 'function')
      return varName;

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

async function createApplication(args) {
  if (!args.dir || !('' + args.dir).match(/\S/))
    args.dir = Path.resolve(process.env.PWD);
  else
    args.dir = Path.resolve(args.dir);

  try {
    let templateClonePath = Path.resolve(args.dir, getFormattedAppName(args.appName));
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

    await spawnProcess('npm', [ 'i' ], { env: { PWD: templateClonePath, CWD: templateClonePath }, cwd: templateClonePath });

    runTemplateEngineOnProject(templateClonePath, await createTemplateEngineContext(templateClonePath, args.appName));

    console.log(`Mythix application created at ${templateClonePath}`);
    console.log('To finalize setup you need to:');
    console.log('  1) Install the correct database driver (default is mythix-orm-postgresql), and update configuration files:');
    console.log(`    a) Open and modify ${Path.join(templateClonePath, 'app', 'config', 'db-config.js')} for database configuration`);
    console.log(`    b) Open and modify ${Path.join(templateClonePath, 'app', 'config', 'sensitive.js')} for API keys`);
    console.log('  2) Define the models for your application');
    console.log('  3) Run migrations: `npx mythix-cli migrate`');
    console.log('  4) Run the DB seeder: `mythix-cli shell` + `await seedDB();`');
    console.log('  5) Finally run your application: `npm run -s start`');
  } catch (error) {
    console.error('ERROR: ', error);
    process.exit(1);
  }
}

async function generateCommandHelp(application, commandsObj, globalHelp) {
  let commandNames = Object.keys(commandsObj || {});
  for (let i = 0, il = commandNames.length; i < il; i++) {
    let commandName = commandNames[i];
    let Klass       = commandsObj[commandName];
    let help        = null;

    if (typeof Klass.commandArguments === 'function') {
      let result = ((await Klass.commandArguments(application, 'help')) || {});
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

async function commandRunners(application, commandsObj, context, showHelp) {
  let commandNames = Object.keys(commandsObj);

  for (let i = 0, il = commandNames.length; i < il; i++) {
    let commandName = commandNames[i];
    let Klass       = commandsObj[commandName];
    let runner      = null;

    if (typeof Klass.commandArguments === 'function') {
      let result = ((await Klass.commandArguments(application, 'runner')) || {});
      runner = result.runner;
    }

    let result = await context.match(commandName, async ({ scope, store, fetch, showHelp }, parserResult) => {
      store({ command: commandName });

      return await scope(commandName, async (context) => {
        if (typeof runner === 'function') {
          let runnerResult = await runner(context, parserResult);
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

function loadJSON(filePath, defaultValue) {
  try {
    let content = FileSystem.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error loading JSON file "${filePath}": `, error);
    return (arguments.length > 1) ? defaultValue : {};
  }
}


(async function() {
  const packageJSONPath = Path.resolve(__dirname, '..', 'package.json');
  const packageJSON     = loadJSON(packageJSONPath, {});

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

    $('create', ({ scope }) => {
      return scope('create', ({ $ }) => {
        $('--dir', Types.STRING({ format: Path.resolve }), { name: 'dir' })
          || $('-d', Types.STRING({ format: Path.resolve }), { name: 'dir' })
          || store({ dir: Path.resolve('./') });

        $('--template', Types.STRING(), { name: 'template' })
          || $('-t', Types.STRING(), { name: 'template' })
          || store({ template: 'https://github.com/th317erd/mythix-app-template.git' });

        return $(/^.*$/, ({ store }, parserResult) => {
          store({ appName: parserResult.appName });
          return true;
        }, {
          formatParsedResult: (value) => {
            return { appName: value[0] };
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
    'create': {
      '@usage': 'mythix-cli create [app name] [options]',
      '@title': 'Initialize a blank mythix application',
      '@see': 'See: \'mythix-cli create --help\' for more help',
      '-d={path} | -d {path} | --dir={path} | --dir {path}': 'Specify directory to create new application in. Default = "./"',
      '-t={url} | -t {url} | --template={url} | --template {url}': 'Specify a git repository URL to use for a template to create the application with. Default = "https://github.com/th317erd/mythix-app-template.git".'
    },
  };

  if (argOptions.create) {
    if (Nife.isEmpty(argOptions.create)) {
      showHelp(help.create);
      return process.exit(1);
    }

    await createApplication(argOptions.create);

    return;
  }

  try {
    let helpShown = false;

    const customShowHelp = (subHelp) => {
      if (helpShown)
        return;

      helpShown = true;

      showHelp(subHelp)
    };

    let rootOptions;
    let mythixPath;
    let mythixCLIPath;
    let mythixCLI;
    let config;

    try {
      rootOptions   = { help, showHelp: customShowHelp, helpArgPattern: null };
      mythixCLIPath = Path.resolve(require.resolve('mythix', { paths: [ process.env.PWD, Path.resolve(process.env.PWD, 'node_modules') ] }));
      mythixPath    = Path.dirname(mythixCLIPath);
      mythixCLI     = (await import(mythixCLIPath)).CLI;
      config        = await mythixCLI.loadMythixConfig(argOptions.config);
    } catch (error) {
      console.error('THERE WAS AN ERROR: ', error);
      customShowHelp(help);
      process.exit(1);
    }

    let Application = await config.getApplicationClass(config);
    if (typeof Application !== 'function')
      throw new Error('Expected to find an Application class from "getApplicationClass", but none was returned.');

    let application         = await mythixCLI.createApplication(Application, { cli: true, database: false, httpServer: false });
    let applicationOptions  = application.getOptions();

    let commands = Application.getCommandList();
    await generateCommandHelp(application, commands, help);

    let commandContext = await CMDed(async (context) => {
      let { $, Types, store } = context;

      store('mythixApplication', application);

      $('--config', Types.STRING({
        format: Path.resolve,
      })) || store({ config: (Nife.isNotEmpty(process.env.MYTHIX_CONFIG_PATH)) ? Path.resolve(process.env.MYTHIX_CONFIG_PATH) : Path.join(process.env.PWD, '.mythix-config.js') });

      $('--runtime', Types.STRING());

      $('-e', Types.STRING(), { name: 'environment' });
      $('--env', Types.STRING(), { name: 'environment' });

      $('--help', Types.BOOLEAN());

      return await commandRunners(application, commands, context, customShowHelp);
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
})();
