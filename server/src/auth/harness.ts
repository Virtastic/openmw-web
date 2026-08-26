// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// The shipped client's ?mpauto=1 harness login uses a FIXED, publicly known password. It lives
// in its own module because BOTH the world server's connection handler and the gateway need it,
// and the gateway must not import the connection handler to get it: that edge drags the entire
// world-server module graph into the gateway entry point, which is a heavy dependency for one
// string and broke the test runner when it was tried.
//
// A test affordance, never an auth method. Every caller must check that the operator opted in
// (`[login] allowHarnessAuth`) before honouring it.
export const HARNESS_PASSWORD = 'harness-pass-1';
