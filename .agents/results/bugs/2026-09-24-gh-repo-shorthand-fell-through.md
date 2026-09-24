# GitHub repository shorthand fell through to model advice

**Date:** 2026-09-24  
**Severity:** Medium (incorrect authentication guidance)  
**Status:** Fix prepared; awaiting GitHub Actions and production deployment

## Problem

In the Agent page, the request `gh repo 我的项目` received advice to sign in to the local GitHub CLI even though the browser showed `OAuth connected · lilyco-42`.

## Root cause

The GitHub intent matcher recognized repository reads only when the message included an explicit list/view verb such as “查看” or “list”. The shorthand named a GitHub repository and said “my projects”, but had no recognized verb. The browser OAuth repository preflight therefore did not run and the model generated unsupported CLI-login advice.

## Fix

Treat ownership phrases such as “我的”, “我自己的”, and “my own” as an implicit request to list repositories when a GitHub repository term is present. Browser repository requests then use the existing deterministic OAuth preflight, so the model cannot substitute a local `gh` login requirement.

## Regression coverage

- `gh repo 我的项目` resolves to the browser OAuth repository-list intent, not a local CLI request.
- The tool loop calls `/api/agent/github/repositories` before inference and returns the OAuth result without asking the model to guess.

## Verification

Pending GitHub Actions frontend tests/build and server artifact build. The previously saved chat answer remains visible in history; a new message after deploying the updated frontend should use the corrected route.
