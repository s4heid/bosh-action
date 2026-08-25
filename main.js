'use strict';

const { execFile, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const execFilePromise = promisify(execFile);
const DEFAULT_IMAGE_REPOSITORY = 'ghcr.io/cloudfoundry/bosh/docker-cpi';

const CONTAINER_PATHS = Object.freeze({
  workspace: '/github/workspace',
  runnerTemp: '/github/runner_temp',
  home: '/github/home',
  workflow: '/github/workflow',
  fileCommands: '/github/file_commands',
  dockerScratch: '/scratch/docker',
});

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Required environment variable ${name} is not set.`);
  }
  return value;
}

function ensureDirectory(directory, fsModule = fs) {
  fsModule.mkdirSync(directory, { recursive: true });
  if (!fsModule.statSync(directory).isDirectory()) {
    throw new Error(`${directory} is not a directory.`);
  }
}

function isWithinPath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function translatePath(value, mappings) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    return value;
  }

  for (const [hostPath, containerPath] of mappings) {
    if (isWithinPath(value, hostPath)) {
      const relative = path.relative(hostPath, value);
      return relative === ''
        ? containerPath
        : path.posix.join(containerPath, ...relative.split(path.sep));
    }
  }

  return value;
}

function resolveScript(script, workspace, mappings, fsModule = fs) {
  const hostScript = path.resolve(workspace, script);
  if (!isWithinPath(hostScript, workspace)) {
    throw new Error(`Script must be located within GITHUB_WORKSPACE: ${script}`);
  }

  let scriptStats;
  try {
    scriptStats = fsModule.statSync(hostScript);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`Script does not exist: ${hostScript}`);
    }
    throw error;
  }

  if (!scriptStats.isFile()) {
    throw new Error(`Script is not a file: ${hostScript}`);
  }
  if ((scriptStats.mode & 0o111) === 0) {
    throw new Error(`Script is not executable: ${hostScript}`);
  }

  return translatePath(hostScript, mappings);
}

function isDockerEnvironmentName(name) {
  return name.length > 0 && !name.includes('=') && !name.includes('\0');
}

function assertSupportedImageArchitecture(image, architecture) {
  const isDefaultImage =
    image === DEFAULT_IMAGE_REPOSITORY ||
    image.startsWith(`${DEFAULT_IMAGE_REPOSITORY}:`) ||
    image.startsWith(`${DEFAULT_IMAGE_REPOSITORY}@`);

  if (isDefaultImage && architecture && architecture.toLowerCase() !== 'x64') {
    throw new Error(
      `${DEFAULT_IMAGE_REPOSITORY} is currently published only for linux/amd64; use an x64 runner or override the image input.`,
    );
  }
}

function buildDockerInvocation(environment, options = {}) {
  const fsModule = options.fsModule || fs;
  const imageEnvironmentNames = new Set(options.imageEnvironmentNames || []);
  const forcedEnvironmentNames = new Set(['HOME', 'TEMP', 'TMP', 'TMPDIR']);
  const workspace = path.resolve(requiredEnvironment(environment, 'GITHUB_WORKSPACE'));
  const runnerTemp = path.resolve(requiredEnvironment(environment, 'RUNNER_TEMP'));
  const script = requiredEnvironment(environment, 'INPUT_SCRIPT');
  const image = requiredEnvironment(environment, 'INPUT_IMAGE');
  assertSupportedImageArchitecture(image, environment.RUNNER_ARCH);
  const containerName =
    options.containerName || `bosh-action-${randomUUID()}`;

  ensureDirectory(workspace, fsModule);
  ensureDirectory(runnerTemp, fsModule);

  const homeDirectory = path.join(runnerTemp, '_github_home');
  const workflowDirectory = path.join(runnerTemp, '_github_workflow');
  const fileCommandsDirectory = path.join(runnerTemp, '_runner_file_commands');

  for (const directory of [homeDirectory, workflowDirectory, fileCommandsDirectory]) {
    ensureDirectory(directory, fsModule);
  }

  const mappings = [
    [homeDirectory, CONTAINER_PATHS.home],
    [workflowDirectory, CONTAINER_PATHS.workflow],
    [fileCommandsDirectory, CONTAINER_PATHS.fileCommands],
    [workspace, CONTAINER_PATHS.workspace],
    [runnerTemp, CONTAINER_PATHS.runnerTemp],
  ].sort(([left], [right]) => right.length - left.length);

  const hostEnvironment = { ...environment };
  const containerEnvironment = {
    ...environment,
    HOME: homeDirectory,
    TEMP: '/tmp',
    TMP: '/tmp',
    TMPDIR: '/tmp',
  };
  const environmentArguments = [];

  for (const name of Object.keys(containerEnvironment).sort()) {
    if (!isDockerEnvironmentName(name) || containerEnvironment[name] === undefined) {
      continue;
    }
    if (
      imageEnvironmentNames.has(name) &&
      !forcedEnvironmentNames.has(name)
    ) {
      continue;
    }

    const hostValue = hostEnvironment[name];
    const containerValue = translatePath(containerEnvironment[name], mappings);
    environmentArguments.push('--env');

    // Keep unchanged values out of the process arguments. Docker copies them
    // from its own environment, including multiline values and secrets.
    environmentArguments.push(
      containerValue === hostValue ? name : `${name}=${containerValue}`,
    );
  }

  const args = [
    'run',
    '--privileged',
    '--rm',
    '--name',
    containerName,
    '--workdir',
    CONTAINER_PATHS.workspace,
    '--volume',
    `${runnerTemp}:${CONTAINER_PATHS.runnerTemp}`,
    '--volume',
    `${homeDirectory}:${CONTAINER_PATHS.home}`,
    '--volume',
    `${workflowDirectory}:${CONTAINER_PATHS.workflow}`,
    '--volume',
    `${fileCommandsDirectory}:${CONTAINER_PATHS.fileCommands}`,
    '--volume',
    `${workspace}:${CONTAINER_PATHS.workspace}`,
    '--volume',
    CONTAINER_PATHS.dockerScratch,
    ...environmentArguments,
    '--entrypoint',
    resolveScript(script, workspace, mappings, fsModule),
    image,
  ];

  return {
    command: 'docker',
    args,
    containerName,
    environment: hostEnvironment,
  };
}

function runCommand(
  command,
  args,
  environment,
  spawnImplementation = spawn,
  stdio = 'inherit',
) {
  return new Promise((resolve, reject) => {
    const child = spawnImplementation(command, args, {
      env: environment,
      stdio,
    });

    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} terminated by signal ${signal}.`));
        return;
      }
      resolve(code === null ? 1 : code);
    });
  });
}

function parseImageEnvironment(output) {
  let entries;
  try {
    entries = JSON.parse(String(output).trim());
  } catch (error) {
    throw new Error(`Could not parse the container image environment: ${error.message}`);
  }

  if (entries === null) {
    return new Set();
  }
  if (!Array.isArray(entries)) {
    throw new Error('Container image environment is not an array.');
  }

  return new Set(
    entries.map((entry) => {
      const separator = entry.indexOf('=');
      return separator === -1 ? entry : entry.slice(0, separator);
    }),
  );
}

async function inspectImageEnvironment(
  image,
  environment,
  dependencies = {},
) {
  const execute = dependencies.execFileImplementation || execFilePromise;
  const run = dependencies.runCommandImplementation || runCommand;
  const inspect = async () => {
    const result = await execute(
      'docker',
      ['image', 'inspect', '--format', '{{json .Config.Env}}', image],
      { env: environment, maxBuffer: 1024 * 1024 },
    );
    return parseImageEnvironment(result.stdout);
  };

  try {
    return await inspect();
  } catch (inspectError) {
    const pullCode = await run('docker', ['pull', image], environment);
    if (pullCode !== 0) {
      throw new Error(`Could not pull container image ${image} (exit code ${pullCode}).`);
    }

    try {
      return await inspect();
    } catch (error) {
      throw new Error(
        `Could not inspect container image ${image} after pulling it: ${error.message}`,
      );
    }
  }
}

async function forceRemoveContainer(
  containerName,
  environment,
  execFileImplementation = execFilePromise,
) {
  if (!containerName) {
    return 0;
  }

  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await execFileImplementation(
        'docker',
        ['rm', '--force', '--volumes', containerName],
        { env: environment, maxBuffer: 1024 * 1024 },
      );
      return 0;
    } catch (error) {
      const errorText = `${error.message || ''}\n${error.stderr || ''}`;
      if (/no such (container|object)/i.test(errorText)) {
        return 0;
      }
      lastError = error;
    }
  }

  throw new Error(
    `Could not remove BOSH container ${containerName}: ${lastError.message}`,
  );
}

function runDocker(invocation, spawnImplementation = spawn, options = {}) {
  return new Promise((resolve, reject) => {
    const signalEmitter = options.signalEmitter || process;
    const removeContainer =
      options.removeContainerImplementation ||
      ((containerName, environment) =>
        forceRemoveContainer(containerName, environment));
    const child = spawnImplementation(invocation.command, invocation.args, {
      env: invocation.environment,
      stdio: 'inherit',
    });
    let cancelledSignal;
    let cancellationPromise = Promise.resolve();
    let settled = false;

    const removeSignalListeners = () => {
      signalEmitter.off('SIGINT', onSigint);
      signalEmitter.off('SIGTERM', onSigterm);
    };

    const removeNamedContainer = async () => {
      const result = await removeContainer(
        invocation.containerName,
        invocation.environment,
      );
      if (
        result === false ||
        (typeof result === 'number' && result !== 0)
      ) {
        throw new Error(
          `Container removal exited with status ${String(result)}.`,
        );
      }
      return result;
    };

    const cancel = (signal) => {
      if (cancelledSignal) {
        return;
      }
      cancelledSignal = signal;
      cancellationPromise = removeNamedContainer().finally(() => {
        child.kill(signal);
      });
    };
    const onSigint = () => cancel('SIGINT');
    const onSigterm = () => cancel('SIGTERM');

    signalEmitter.once('SIGINT', onSigint);
    signalEmitter.once('SIGTERM', onSigterm);

    child.once('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignalListeners();
      reject(error);
    });
    child.once('close', async (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignalListeners();

      if (cancelledSignal) {
        try {
          await cancellationPromise;
        } catch {
          try {
            await removeNamedContainer();
          } catch (secondCleanupError) {
            reject(
              new Error(
                `BOSH container was cancelled by ${cancelledSignal}, but cleanup failed: ${secondCleanupError.message}`,
              ),
            );
            return;
          }
        }
        reject(new Error(`BOSH container cancelled by signal ${cancelledSignal}.`));
        return;
      }
      if (signal) {
        try {
          await removeNamedContainer();
        } catch (error) {
          reject(
            new Error(
              `BOSH container terminated by ${signal}, but cleanup failed: ${error.message}`,
            ),
          );
          return;
        }
        reject(new Error(`BOSH container terminated by signal ${signal}.`));
        return;
      }
      resolve(code === null ? 1 : code);
    });
  });
}

function escapeWorkflowCommand(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

async function main() {
  try {
    if (process.platform !== 'linux') {
      throw new Error('bosh-action requires a Linux runner with Docker installed.');
    }

    const image = requiredEnvironment(process.env, 'INPUT_IMAGE');
    const imageEnvironmentNames = await inspectImageEnvironment(
      image,
      process.env,
    );
    const invocation = buildDockerInvocation(process.env, {
      imageEnvironmentNames,
    });
    process.exitCode = await runDocker(invocation);
  } catch (error) {
    console.error(`::error::${escapeWorkflowCommand(error.message || error)}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  CONTAINER_PATHS,
  DEFAULT_IMAGE_REPOSITORY,
  assertSupportedImageArchitecture,
  buildDockerInvocation,
  escapeWorkflowCommand,
  forceRemoveContainer,
  inspectImageEnvironment,
  isWithinPath,
  parseImageEnvironment,
  resolveScript,
  runCommand,
  runDocker,
  translatePath,
};
