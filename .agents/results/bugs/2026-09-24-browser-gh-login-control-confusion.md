# Browser GitHub card showed local CLI login instructions

**Date**: 2026-09-24  
**Severity**: Medium (confusing authentication guidance)  
**Status**: Fixed in source; GitHub Actions verification pending

## Problem

The web Agent's GitHub card displayed a `Check gh login` button and a link to `gh auth login` even in a normal browser session. In that session the check handler only refreshed browser OAuth status; it could not inspect a local CLI. This made a working `OAuth connected` state appear to require an unrelated local login.

## Fix

Render local `gh` status, login details, and CLI setup instructions only when the Tauri runtime is present. Browser sessions continue to use the site's GitHub OAuth API for repository search, Issues, and Pull Requests.

## Regression coverage

The GitHub card test asserts that a browser session can load OAuth status without showing local `gh` login controls. Existing tests continue to cover OAuth connection and browser repository search behavior.

## Verification

Run the frontend tests and production build in GitHub Actions. Do not use a local build for this project.
