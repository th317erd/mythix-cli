#!/usr/bin/env node

import Path               from 'node:path';
import { spawn }          from 'node:child_process';
import { fileURLToPath }  from 'node:url';
import { CMDed, Types }   from 'cmded';

const __filename = fileURLToPath(import.meta.url);
const __dirname = Path.dirname(__filename);

function spawnCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    try {
      let childProcess = spawn(
        command,
        args,
        Object.assign({}, options || {}, {
          env:    Object.assign({}, process.env, (options || {}).env || {}),
          stdio:  'inherit',
        }),
      );

      childProcess.on('error', (error) => {
        reject(error);
      });

      childProcess.on('close', (code) => {
        resolve(code);
      });
    } catch (error) {
      reject(error);
    }
  });
}

(async function () {
  let config;

  // Windows hack
  if(!process.env.PWD)
    process.env.PWD = process.cwd();

  let argOptions = CMDed(({ $, store }) => {
    $('--config', Types.STRING({
      format: Path.resolve,
    })) || store({ config: Path.join(process.env.PWD, '.mythix-config.js') });

    $('--runtime', Types.STRING());

    return true;
  });

  try {
    config = await import(argOptions.config);
  } catch (error) {
    config = {};
  }

  const args        = process.argv.slice(2);
  const runtime     = argOptions.runtime || config.runtime || 'node';
  const runtimeArgs = config.runtimeArgs || [];
  const hasCMD      = ((/\.cmd$/i).test(runtime));
  const commands    = [ runtime, (process.platform == 'win32' && !hasCMD) ? `${runtime}.cmd` : undefined ].filter(Boolean);

  for (let i = 0, il = commands.length; i < il; i++) {
    let command = commands[i];

    try {
      await spawnCommand(command, runtimeArgs.concat([ Path.resolve(__dirname, 'runner.js') ], args));
      break;
    } catch (error) {
      if (error.code === 'ENOENT' && (i + 1) < commands.length)
        continue;

      console.error(error);
      throw error;
    }
  }
})();
