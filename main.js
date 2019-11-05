const execFile = require('child_process').execFile;
const execFilePromise = require('util').promisify(execFile);
const process = require('process');

async function makeTmpDir() {
    execFilePromise("mkdir", ["-p", "/home/runner/_temp/_docker_scratch"], (error, stdout, stderr) => {
    if (error) {
        throw error;
    }
    console.log(stdout);
  });
};
makeTmpDir();

const docker = execFile(
    "docker",
    [
        "run",
        "--privileged",
        "--workdir", "/github/workspace",
        "--rm",
        "--tty",
        "-e", "INPUT_ENTRYPOINT",
        "-e", "INPUT_ARGS",
        "-e", "HOME",
        "-e", "GITHUB_REF",
        "-e", "GITHUB_SHA",
        "-e", "GITHUB_REPOSITORY",
        "-e", "GITHUB_ACTOR",
        "-e", "GITHUB_WORKFLOW",
        "-e", "GITHUB_HEAD_REF",
        "-e", "GITHUB_BASE_REF",
        "-e", "GITHUB_EVENT_NAME",
        "-e", "GITHUB_WORKSPACE",
        "-e", "GITHUB_ACTION",
        "-e", "GITHUB_EVENT_PATH",
        "-e", "RUNNER_OS",
        "-e", "RUNNER_TOOL_CACHE",
        "-e", "RUNNER_TEMP",
        "-e", "RUNNER_WORKSPACE",
        "-e", "ACTIONS_RUNTIME_URL",
        "-e", "ACTIONS_RUNTIME_TOKEN",
        "-e", "GITHUB_ACTIONS=true",
        "--entrypoint", process.env.INPUT_SCRIPT,
        "-v", "/var/run/docker.sock:/var/run/docker.sock",
        "-v", "/home/runner/work/_temp/_github_home:/github/home",
        "-v", "/home/runner/work/_temp/_github_workflow:/github/workflow",
        "-v", "/home/runner/work/athens-bosh-release/athens-bosh-release:/github/workspace",
        // provide a non-layered scratch space on the host to avoid errors like:
        //  > Creating container: Error response from daemon: error creating aufs mount to /var/lib/docker/aufs/mnt/...snip...-init
        // related: https://github.com/cloudfoundry/bosh/pull/1698
        "-v", "/home/runner/_temp/_docker_scratch:/scratch/docker",
        "bosh/main-bosh-docker",
    ]
)

docker.stdout.pipe(process.stdout);
docker.stderr.pipe(process.stderr);
docker.on('exit', (code) => {
    process.exit(code);
})