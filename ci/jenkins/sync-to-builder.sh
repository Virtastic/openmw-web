#!/usr/bin/env bash
# RETIRED. Builds come from the `dev` branch now; this script no longer does anything.
#
# It used to rsync the laptop's working tree to the build server, and it is kept as a refusal
# rather than deleted because the muscle memory outlives the script — running it and getting
# "command not found" tells you nothing about what to do instead.
#
# Why it went away, beyond the workflow change: it synced the WHOLE tree, including
# ci/jenkins/config.env. That file has to serve two machines at once — BUILDER is resolved from
# the laptop, while TEST_HOST/SSH_KEY are resolved on the build server, inside the Jenkins
# container. Overwriting it on every sync is how the deploy stage silently broke: the container
# got a `test-vm` alias it cannot resolve and a key path under ~/Documents that does not exist
# there, so Jenkins deploys failed while hand-run deploys worked. Nobody saw a red build, because
# the job simply stopped being used.
#
# The flow now (see AGENTS.md "The loop"):
#   1. commit to a branch off dev, push it, open a PR against dev
#   2. the maintainer approves and merges
#   3. Jenkins polls dev, builds, and deploys to the test server on its own
set -euo pipefail
cat >&2 <<'MSG'
sync-to-builder.sh is RETIRED — Jenkins builds from the `dev` branch now.

  git push -u origin <your-branch>     # then open a PR against dev
  # maintainer approves + merges -> Jenkins builds and deploys within ~2 minutes

There is no manual build or deploy step any more. To build something uncommitted, commit it
to a branch and push it. See AGENTS.md, "The loop".
MSG
exit 1
