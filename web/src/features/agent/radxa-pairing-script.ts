/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
*/

export const RADXA_COMPANION_RELEASE_TAG = 'lain42-agent-v0.1.1'

const INSTALLER_URL =
  `https://github.com/lilyco-42/new-api/releases/download/${RADXA_COMPANION_RELEASE_TAG}/install.sh`

export function createRadxaPairingScript(apiOrigin: string): string {
  let origin: URL
  try {
    origin = new URL(apiOrigin)
  } catch {
    throw new Error('Enter a valid Lain42 site URL.')
  }

  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('Radxa pairing requires an HTTPS site origin.')
  }

  // The URL class canonicalizes the host. A host cannot contain shell quotes,
  // whitespace, or command substitutions, so the generated copy command stays
  // safe while still working in Bash, zsh, and POSIX-compatible terminals.
  return `bash -o pipefail -c 'curl --fail --location --silent --show-error ${INSTALLER_URL} | bash -s -- --api-origin ${origin.origin}'`
}
