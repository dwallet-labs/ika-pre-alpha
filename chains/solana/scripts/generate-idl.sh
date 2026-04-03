#!/usr/bin/env bash
# Generate the Codama IDL JSON from the program source.
# Output: idl/ika_system_program.json
#
# NOTE: This requires the full ika repo with program source code.
# In the pre-alpha repo, copy the generated IDL manually.

set -euo pipefail
cd "$(dirname "$0")/.."

echo "Generating IDL..."
echo "ERROR: IDL generation requires ika-system-program source (not in pre-alpha repo)."
echo "Copy ika_system_program.json to idl/ from the full ika repo."
exit 1
