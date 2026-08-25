#!/usr/bin/env bash

set -Eeuo pipefail

readonly deployment_name="bosh-action-smoke"
readonly director_dir="/tmp/local-bosh/director"
readonly release_fixture="${GITHUB_WORKSPACE}/test/fixtures/dummy-release"
readonly release_tarball="/tmp/bosh-action-smoke-release.tgz"
readonly deployment_manifest="${GITHUB_WORKSPACE}/test/fixtures/deployment.yml"

release_dir="$(mktemp -d)"
readonly release_dir
cp -R "${release_fixture}/." "${release_dir}/"

deployment_started=false

cleanup() {
  local test_status=$?
  local cleanup_status=0
  local command_status=0

  trap - EXIT
  set +e

  if [[ "${deployment_started}" == "true" ]]; then
    bosh -n -d "${deployment_name}" delete-deployment --force
    cleanup_status=$?
  fi

  if [[ -f "${director_dir}/bosh-director.yml" ]]; then
    bosh -n delete-env "${director_dir}/bosh-director.yml" \
      --vars-store="${director_dir}/creds.yml" \
      --state="${director_dir}/state.json"
    command_status=$?
    if [[ ${command_status} -ne 0 && ${cleanup_status} -eq 0 ]]; then
      cleanup_status=${command_status}
    fi
  fi

  service docker stop
  command_status=$?
  if [[ ${command_status} -ne 0 && ${cleanup_status} -eq 0 ]]; then
    cleanup_status=${command_status}
  fi

  if [[ ${test_status} -eq 0 ]]; then
    test_status=${cleanup_status}
  fi
  exit "${test_status}"
}

trap cleanup EXIT

# shellcheck source=/dev/null
source /usr/local/bin/start-bosh

if [[ -f "${director_dir}/bosh-env" ]]; then
  # shellcheck source=/dev/null
  source "${director_dir}/bosh-env"
elif [[ -f "${director_dir}/env" ]]; then
  # shellcheck source=/dev/null
  source "${director_dir}/env"
else
  echo "start-bosh did not create a director environment file" >&2
  exit 1
fi

stemcell_url="$(
  bosh interpolate /usr/local/bosh-deployment/docker/cpi.yml \
    --path /name=stemcell/value/url
)"
stemcell_os="$(grep -oE 'ubuntu-[a-z]+' <<<"${stemcell_url}")"

bosh -n upload-stemcell "${stemcell_url}"

(
  cd "${release_dir}"
  bosh create-release \
    --force \
    --name=bosh-action-smoke \
    --version=1.0.0 \
    --tarball="${release_tarball}"
)
bosh -n upload-release "${release_tarball}"

deployment_started=true
bosh -n -d "${deployment_name}" deploy \
  --var="stemcell_os=${stemcell_os}" \
  "${deployment_manifest}"
bosh -n -d "${deployment_name}" run-errand smoke
