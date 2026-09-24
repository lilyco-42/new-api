# Generic chat triggered a paired-device workspace tool

**Date**: 2026-09-24  
**Severity**: High (unexpected access to a user's private device)  
**Status**: Fix implemented; awaiting GitHub Actions and production verification

## Problem

A normal knowledge question about Rust caused the model to propose `files.browse`. The browser provider advertised paired-device tools for unrelated requests and treated non-GitHub tools as runnable by default. The paired device rejected the request because its workspace was not configured; no file listing was returned. This also risked routing unrelated conversation to a user's private Radxa or desktop.

## Fix

Use a fail-closed intent map for local and paired-device tools. A tool is advertised and executable only when the latest user request explicitly matches its operation and target: workspace listing needs an explicit workspace/file request, file preview needs an explicit file-read request, and code/history tools need matching repository intent. Unknown local tool names remain disabled until mapped. GitHub browser OAuth and browser web search retain their separate intent routing.

## Regression coverage

Tests cover generic questions excluding local file/code/history tools, explicit workspace requests enabling only the matching operation, file preview requiring an explicit file target, and a model-proposed unrelated `files.browse` call being rejected without invoking the paired device.

## Verification

Pending GitHub Actions. Local builds and tests are intentionally not used; production verification will use the CI-built artifact.
