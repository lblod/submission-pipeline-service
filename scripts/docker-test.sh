#!/bin/bash
# Runs the tests inside the base image from the Dockerfile. `mu` is not an npm
# package: the template provides it, so we install it into node_modules the same way.
set -euo pipefail
cd "$(dirname "$0")/.."

BASE_IMAGE=$(grep -m1 '^FROM' Dockerfile | awk '{print $2}')
echo "Running tests in ${BASE_IMAGE} ..."

docker run --rm -v "$PWD":/app -v /app/node_modules -w /app "$BASE_IMAGE" bash -c '
  # Copy the templates modules aside first; our npm install can leave them unreadable.
  cp -r /usr/src/app/node_modules /tmp/template-node-modules
  cp -r /usr/src/app/helpers/mu /tmp/template-mu

  npm install --no-audit --no-fund

  # Merge in the templates runtime deps without overwriting ours, then add mu, as
  # npm-install-dependencies.sh does. package.json pins uuid@9 so jsdoms old uuid
  # does not shadow the one mu imports.
  cp -rn /tmp/template-node-modules/. node_modules/
  mkdir -p node_modules/mu
  cp -r /tmp/template-mu/* node_modules/mu/

  node --test test/
'
