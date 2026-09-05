// Copyright (C) 2025-2026 Virtastic - https://virtastic.app
// SPDX-License-Identifier: GPL-3.0-or-later | part of openmw-web
// "Forgot my password", for the dashboard. One implementation, two servers: a game and the
// multiplayer server both serve /admin against the same shared account store, and the reset
// flow must behave identically on each or an operator locked out of one has a different
// recovery story depending on which program happens to be running.

import type { AccountStore } from '../../core/accounts';
import type { AdminSessionStore } from '../../auth/identities';
import { ResetTokens, sendMail, type MailConfig } from './notify';
import { passwordProblem } from './auth';
import { log } from '../../log';

export interface ResetDeps {
  accounts: AccountStore;
  sessions: AdminSessionStore;
  mail: () => MailConfig;
  /** The origin the reset link opens on, e.g. https://mp.example.com. */
  base: () => string;
  serverName: () => string;
}

export function passwordReset(deps: ResetDeps): {
  sendPasswordReset(name: string): Promise<void>;
  applyPasswordReset(token: string, password: string): Promise<{ ok: boolean; message: string }>;
} {
  const tokens = new ResetTokens();
  return {
    sendPasswordReset: async (name) => {
      // Every failure path here is silent BY DESIGN. The endpoint answers identically
      // whether the account exists, has no address, or has no dashboard access, because a
      // difference in any of those is an account-and-email enumeration oracle. The operator
      // who typed their own name knows which it was; an attacker learns nothing.
      try {
        const account = await deps.accounts.get(name);
        if (!account?.email || !account.dashboardRole) return;
        const token = tokens.mint(name.toLowerCase());
        await sendMail(deps.mail(), account.email,
          'Reset your openmw-mp admin password',
          [
            `Someone asked to reset the password for "${account.name}" on ${deps.serverName()}.`,
            '',
            'Open this link to choose a new one. It works once and expires in 30 minutes:',
            `${deps.base()}/admin#reset=${token}`,
            '',
            'If this was not you, nothing has changed and you can ignore this message.',
          ].join('\n'));
        log('info', 'admin.reset_sent', { account: name.toLowerCase() });
      } catch (err) {
        log('warn', 'admin.reset_send_failed', { error: String(err) });
      }
    },
    applyPasswordReset: async (token, password) => {
      const accountKey = tokens.consume(token);
      if (!accountKey) return { ok: false, message: 'that link has expired or was already used' };
      const weak = passwordProblem(password, accountKey);
      if (weak) return { ok: false, message: `password ${weak}` };
      if (!await deps.accounts.setPassword(accountKey, password)) {
        return { ok: false, message: 'account not found' };
      }
      // Any session opened with the old password is no longer the person's session as far
      // as we can tell, so end all of them.
      deps.sessions.revokeAccount(accountKey);
      await deps.accounts.flush();
      log('warn', 'admin.password_reset', { account: accountKey });
      return { ok: true, message: 'password changed — sign in with it now' };
    },
  };
}
