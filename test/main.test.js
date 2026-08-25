'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertSupportedImageArchitecture,
  buildDockerInvocation,
  escapeWorkflowCommand,
  forceRemoveContainer,
  inspectImageEnvironment,
  parseImageEnvironment,
  resolveScript,
  runDocker,
  translatePath,
} = require('../main');

function createActionEnvironment(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bosh-action-test-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));

  const workspace = path.join(root, 'work', 'example', 'example');
  const runnerTemp = path.join(root, 'temp');
  const fileCommands = path.join(runnerTemp, '_runner_file_commands');
  const workflow = path.join(runnerTemp, '_github_workflow');
  const script = path.join(workspace, 'ci', 'test.sh');

  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.mkdirSync(fileCommands, { recursive: true });
  fs.mkdirSync(workflow, { recursive: true });
  fs.writeFileSync(script, '#!/usr/bin/env bash\nset -eu\n');
  fs.chmodSync(script, 0o755);

  const githubEnvironmentFile = path.join(fileCommands, 'set_env_123');
  const eventPath = path.join(workflow, 'event.json');
  fs.writeFileSync(githubEnvironmentFile, '');
  fs.writeFileSync(eventPath, '{}');

  return {
    workspace,
    runnerTemp,
    script,
    environment: {
      ACTIONS_RUNTIME_URL: 'https://pipelines.actions.githubusercontent.com/example',
      CUSTOM_MULTILINE: 'first line\nsecond line',
      GITHUB_ENV: githubEnvironmentFile,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REPOSITORY: 'example/example',
      GITHUB_WORKSPACE: workspace,
      GOROOT: '/host/go',
      HOME: '/home/runner',
      INPUT_IMAGE: 'ghcr.io/cloudfoundry/bosh/docker-cpi:main',
      INPUT_SCRIPT: './ci/test.sh',
      JAVA_HOME: '/host/java',
      PATH: '/host/tools:/usr/bin',
      RUNNER_TEMP: runnerTemp,
      RUNNER_ARCH: 'X64',
      TMPDIR: path.join(root, 'host-tmp'),
    },
  };
}

function valuesForOption(args, option) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === option) {
      values.push(args[index + 1]);
    }
  }
  return values;
}

test('builds a generic GitHub runner container invocation', (t) => {
  const fixture = createActionEnvironment(t);
  const invocation = buildDockerInvocation(fixture.environment, {
    containerName: 'bosh-action-test',
    imageEnvironmentNames: ['GOROOT', 'JAVA_HOME', 'PATH'],
  });
  const volumes = valuesForOption(invocation.args, '--volume');
  const containerEnvironment = valuesForOption(invocation.args, '--env');

  assert.equal(invocation.command, 'docker');
  assert.deepEqual(invocation.args.slice(0, 3), ['run', '--privileged', '--rm']);
  assert.ok(volumes.includes(`${fixture.workspace}:/github/workspace`));
  assert.ok(volumes.includes(`${fixture.runnerTemp}:/github/runner_temp`));
  assert.ok(!volumes.includes('/var/run/docker.sock:/var/run/docker.sock'));
  assert.ok(volumes.includes('/scratch/docker'));
  assert.ok(!invocation.args.includes('--tty'));
  assert.ok(!invocation.args.join(' ').includes('athens-bosh-release'));
  assert.equal(valuesForOption(invocation.args, '--name')[0], 'bosh-action-test');
  assert.equal(
    valuesForOption(invocation.args, '--entrypoint')[0],
    '/github/workspace/ci/test.sh',
  );
  assert.equal(
    invocation.args.at(-1),
    'ghcr.io/cloudfoundry/bosh/docker-cpi:main',
  );

  assert.ok(containerEnvironment.includes('CUSTOM_MULTILINE'));
  assert.ok(!invocation.args.includes('first line\nsecond line'));
  assert.ok(containerEnvironment.includes('HOME=/github/home'));
  assert.ok(containerEnvironment.includes('TEMP=/tmp'));
  assert.ok(containerEnvironment.includes('TMP=/tmp'));
  assert.ok(containerEnvironment.includes('TMPDIR=/tmp'));
  assert.ok(!containerEnvironment.includes('GOROOT'));
  assert.ok(!containerEnvironment.includes('JAVA_HOME'));
  assert.ok(!containerEnvironment.includes('PATH'));
  assert.ok(
    containerEnvironment.includes(
      'GITHUB_ENV=/github/file_commands/set_env_123',
    ),
  );
  assert.ok(
    containerEnvironment.includes('GITHUB_EVENT_PATH=/github/workflow/event.json'),
  );
  assert.ok(
    containerEnvironment.includes('GITHUB_WORKSPACE=/github/workspace'),
  );
  assert.ok(
    containerEnvironment.includes('RUNNER_TEMP=/github/runner_temp'),
  );
  assert.equal(invocation.environment.HOME, '/home/runner');
  assert.equal(invocation.environment.PATH, '/host/tools:/usr/bin');
});

test('translates mounted paths without changing unrelated values', () => {
  const mappings = [
    ['/runner/temp/files', '/github/file_commands'],
    ['/runner/temp', '/github/runner_temp'],
  ];

  assert.equal(
    translatePath('/runner/temp/files/output', mappings),
    '/github/file_commands/output',
  );
  assert.equal(
    translatePath('/runner/temp/cache', mappings),
    '/github/runner_temp/cache',
  );
  assert.equal(
    translatePath('/runner/temp/..cache', mappings),
    '/github/runner_temp/..cache',
  );
  assert.equal(translatePath('/runner/temporary', mappings), '/runner/temporary');
  assert.equal(translatePath('./relative/path', mappings), './relative/path');
  assert.equal(translatePath('plain value', mappings), 'plain value');
});

test('rejects missing, non-executable, and escaping workspace scripts', (t) => {
  const fixture = createActionEnvironment(t);

  assert.throws(
    () => buildDockerInvocation({ ...fixture.environment, INPUT_SCRIPT: '' }),
    /INPUT_SCRIPT is not set/,
  );
  assert.throws(
    () =>
      buildDockerInvocation({
        ...fixture.environment,
        INPUT_SCRIPT: '../outside.sh',
      }),
    /must be located within GITHUB_WORKSPACE/,
  );
  assert.throws(
    () =>
      resolveScript(
        '/usr/local/bin/start-bosh',
        fixture.workspace,
        [[fixture.workspace, '/github/workspace']],
      ),
    /must be located within GITHUB_WORKSPACE/,
  );

  fs.chmodSync(fixture.script, 0o644);
  assert.throws(
    () => buildDockerInvocation(fixture.environment),
    /Script is not executable/,
  );
});

test('rejects the amd64-only default image on ARM runners', () => {
  assert.throws(
    () =>
      assertSupportedImageArchitecture(
        'ghcr.io/cloudfoundry/bosh/docker-cpi:main',
        'ARM64',
      ),
    /published only for linux\/amd64/,
  );
  assert.doesNotThrow(() =>
    assertSupportedImageArchitecture('example/custom-bosh:latest', 'ARM64'),
  );
});

test('returns the Docker exit code', async () => {
  const child = new EventEmitter();
  const spawnImplementation = (command, args, options) => {
    assert.equal(command, 'docker');
    assert.deepEqual(args, ['run', 'example']);
    assert.equal(options.stdio, 'inherit');
    process.nextTick(() => child.emit('close', 42, null));
    return child;
  };

  const code = await runDocker(
    {
      command: 'docker',
      args: ['run', 'example'],
      environment: {},
    },
    spawnImplementation,
  );

  assert.equal(code, 42);
});

test('parses and loads image-owned environment names', async () => {
  assert.deepEqual(
    [...parseImageEnvironment('["PATH=/image/bin","JAVA_HOME=/image/java"]')],
    ['PATH', 'JAVA_HOME'],
  );
  assert.deepEqual([...parseImageEnvironment('null')], []);

  const cached = await inspectImageEnvironment('example:cached', {}, {
    execFileImplementation: async () => ({
      stdout: '["PATH=/image/bin"]\n',
    }),
    runCommandImplementation: async () => {
      assert.fail('cached image should not be pulled');
    },
  });
  assert.deepEqual([...cached], ['PATH']);

  let inspectCalls = 0;
  const pulled = await inspectImageEnvironment('example:missing', {}, {
    execFileImplementation: async () => {
      inspectCalls += 1;
      if (inspectCalls === 1) {
        throw new Error('No such image');
      }
      return { stdout: '["GOROOT=/usr/local/go"]' };
    },
    runCommandImplementation: async (command, args) => {
      assert.equal(command, 'docker');
      assert.deepEqual(args, ['pull', 'example:missing']);
      return 0;
    },
  });
  assert.deepEqual([...pulled], ['GOROOT']);
  assert.equal(inspectCalls, 2);
});

test('reports Docker startup and signal failures', async (t) => {
  await t.test('startup error', async () => {
    const child = new EventEmitter();
    const result = runDocker(
      { command: 'docker', args: [], environment: {} },
      () => {
        process.nextTick(() => child.emit('error', new Error('docker missing')));
        return child;
      },
    );

    await assert.rejects(result, /docker missing/);
  });

  await t.test('signal', async () => {
    const child = new EventEmitter();
    const result = runDocker(
      { command: 'docker', args: [], environment: {} },
      () => {
        process.nextTick(() => child.emit('close', null, 'SIGTERM'));
        return child;
      },
    );

    await assert.rejects(result, /terminated by signal SIGTERM/);
  });
});

test('removes the named container when the action is cancelled', async () => {
  const child = new EventEmitter();
  const signalEmitter = new EventEmitter();
  const removals = [];
  child.kill = (signal) => {
    process.nextTick(() => child.emit('close', null, signal));
    return true;
  };

  const result = runDocker(
    {
      command: 'docker',
      args: ['run', '--name', 'bosh-action-cancelled', 'example'],
      containerName: 'bosh-action-cancelled',
      environment: {},
    },
    () => child,
    {
      signalEmitter,
      removeContainerImplementation: async (containerName) => {
        removals.push(containerName);
        return 0;
      },
    },
  );

  signalEmitter.emit('SIGTERM');

  await assert.rejects(result, /cancelled by signal SIGTERM/);
  assert.deepEqual(removals, ['bosh-action-cancelled']);
  assert.equal(signalEmitter.listenerCount('SIGINT'), 0);
  assert.equal(signalEmitter.listenerCount('SIGTERM'), 0);
});

test('retries cancellation cleanup and reports persistent failures', async (t) => {
  await t.test('retry succeeds', async () => {
    const child = new EventEmitter();
    const signalEmitter = new EventEmitter();
    let attempts = 0;
    child.kill = (signal) => {
      process.nextTick(() => child.emit('close', null, signal));
      return true;
    };

    const result = runDocker(
      {
        command: 'docker',
        args: ['run', 'example'],
        containerName: 'bosh-action-retry',
        environment: {},
      },
      () => child,
      {
        signalEmitter,
        removeContainerImplementation: async () => {
          attempts += 1;
          return attempts === 1 ? 1 : 0;
        },
      },
    );

    signalEmitter.emit('SIGINT');

    await assert.rejects(result, /cancelled by signal SIGINT/);
    assert.equal(attempts, 2);
  });

  await t.test('retry fails', async () => {
    const child = new EventEmitter();
    const signalEmitter = new EventEmitter();
    let attempts = 0;
    child.kill = (signal) => {
      process.nextTick(() => child.emit('close', null, signal));
      return true;
    };

    const result = runDocker(
      {
        command: 'docker',
        args: ['run', 'example'],
        containerName: 'bosh-action-stuck',
        environment: {},
      },
      () => child,
      {
        signalEmitter,
        removeContainerImplementation: async () => {
          attempts += 1;
          return 1;
        },
      },
    );

    signalEmitter.emit('SIGTERM');

    await assert.rejects(result, /cleanup failed/);
    assert.equal(attempts, 2);
  });
});

test('force removal retries transient Docker failures', async () => {
  let attempts = 0;
  const execute = async (command, args) => {
    attempts += 1;
    assert.equal(command, 'docker');
    assert.deepEqual(args, ['rm', '--force', '--volumes', 'bosh-action-test']);
    if (attempts === 1) {
      throw new Error('Docker daemon temporarily unavailable');
    }
  };

  assert.equal(
    await forceRemoveContainer('bosh-action-test', {}, execute),
    0,
  );
  assert.equal(attempts, 2);
});

test('escapes workflow command control characters', () => {
  assert.equal(
    escapeWorkflowCommand('100%\r\nfailed'),
    '100%25%0D%0Afailed',
  );
});
