# BOSH Action

Run an executable script from a GitHub Actions workspace inside the official
BOSH Docker CPI integration container. The script can start an ephemeral local
BOSH director for release integration tests.

The action uses the official
[`ghcr.io/cloudfoundry/bosh/docker-cpi:main`](https://github.com/cloudfoundry/bosh/pkgs/container/bosh%2Fdocker-cpi)
image by default. The image is built by the
[`cloudfoundry/bosh`](https://github.com/cloudfoundry/bosh) project and contains
the BOSH CLI, Docker CPI dependencies, and the `start-bosh` helper.

## Usage

```yaml
name: Integration test

on:
  pull_request:
  push:
    branches:
      - main

permissions:
  contents: read

jobs:
  integration:
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    steps:
      - name: Check out repository
        uses: actions/checkout@v7

      - name: Run tests against a local BOSH director
        uses: s4heid/bosh-action@v2
        with:
          script: ./ci/actions/test.sh
```

The script must be executable and use a shebang:

```bash
#!/usr/bin/env bash

set -Eeuo pipefail

trap 'service docker stop' EXIT

source /usr/local/bin/start-bosh
source /tmp/local-bosh/director/bosh-env

# Upload a stemcell and release, then deploy and test them.
```

`start-bosh` must be sourced so its environment remains available and its
Docker daemon can be stopped before the action exits. Current upstream images
write `bosh-env`; older images wrote `env`.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `script` | **Yes** | | Executable path in the checked-out workspace. |
| `image` | No | `ghcr.io/cloudfoundry/bosh/docker-cpi:main` | Container image used for the local BOSH environment. Pin this to a digest when reproducibility is more important than automatic upstream updates. |

## Runtime behavior

The action requires a Linux runner with Docker. It starts the configured image
with `--privileged` because the upstream Docker CPI environment launches its own
nested Docker daemon and systemd-based BOSH VMs. The host Docker socket is not
exposed inside the action container. The default upstream image is currently
published for `linux/amd64`, so use an x64 runner unless the `image` input names
a compatible alternative.

The action mirrors GitHub's container-action filesystem layout:

- `${GITHUB_WORKSPACE}` is mounted at `/github/workspace`.
- `${RUNNER_TEMP}` is mounted at `/github/runner_temp`.
- GitHub workflow command files are mounted at `/github/file_commands`.
- GitHub's temporary home and workflow directories are mounted at their
  standard container paths.
- `/scratch/docker` is an anonymous Docker volume used by the nested daemon.

> [!NOTE]
> The action environment is forwarded without embedding unchanged values in the Docker command line. Filesystem paths under mounted runner directories are translated to their container paths. This allows inputs, workflow variables, secrets, and current GitHub runtime variables to work without a hardcoded allowlist. Variables defined by the image itself, such as `PATH`, `JAVA_HOME`, and `GOROOT`, keep their image values so host tool-cache paths do not hide tools installed in the container.

> [!CAUTION]
> The invoked workspace script runs in a privileged container with every environment variable available to the action step. Treat it with the same trust as arbitrary code running directly on the runner:
>
> - Do not use this action to execute untrusted pull-request code with secrets or write-enabled tokens.
> - Keep `GITHUB_TOKEN` permissions at the minimum required by the workflow.
> - Use an ephemeral runner. Standard GitHub-hosted runners already provide a fresh virtual machine for each job.

## Why `docker-cpi`

The original action used `bosh/main-bosh-docker`. The BOSH project replaced
that image with `bosh/integration` in
[cloudfoundry/bosh@abf3ea8](https://github.com/cloudfoundry/bosh/commit/abf3ea8d59144398947553d7cc857084bc91b172)
because `main-bosh-docker` was no longer being built. BOSH moved its CI images
from Docker Hub to GHCR in
[cloudfoundry/bosh@59190dc](https://github.com/cloudfoundry/bosh/commit/59190dcc681515474c01f2e9cf0416b69e024c90).

The bare GHCR integration image is not publicly pullable. The public
`ghcr.io/cloudfoundry/bosh/docker-cpi` image is built from that integration
image, is actively maintained by the same pipeline, and adds the exact
`start-bosh` tooling this action needs. The Docker Hub
`bosh/integration:latest` image remains public but stopped receiving updates
when publishing moved to GHCR, so it is not used as the default.

## Development

Unit tests use only Node.js built-ins:

```console
npm test
```

The repository workflow also performs a scheduled end-to-end smoke test. It
creates a dummy BOSH release, starts a local Docker CPI director, uploads the
current upstream stemcell, deploys the release as an errand, runs it, and tears
down both the deployment and director.
