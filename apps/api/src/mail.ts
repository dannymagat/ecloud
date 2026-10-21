/**
 * Outbound mail, used by captive-portal email OTP (docs/PORTAL_LOGIN_METHODS_DESIGN.md §4.1).
 *
 * One transport for the process, built from `config.base.mail`. When SMTP is not configured the
 * sender is null and every caller must treat that as "this method is unavailable" rather than
 * silently succeeding — an OTP that is never sent looks to the guest like a broken portal.
 *
 * Nothing here logs an address or a code. A delivery failure logs the SMTP error only; the
 * recipient is a tenant's guest and their address is personal data that does not belong in logs
 * that operators and support staff read.
 */
import { createTransport, type Transporter } from 'nodemailer';
import type { ApiConfig } from './config.js';

export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * The transport for this process, or null when SMTP is not configured.
 *
 * `pool: true` keeps a small number of connections rather than opening one per code: a busy site
 * sending a code per guest would otherwise spend most of its time in TLS handshakes, and some
 * relays rate-limit connections much harder than messages.
 */
export function createMailer(config: ApiConfig): Mailer | null {
  const mail = config.base.mail;
  if (mail === null) return null;

  const transporter: Transporter = createTransport({
    host: mail.host,
    port: mail.port,
    // Implicit TLS on 465; STARTTLS (upgraded after connect) everywhere else.
    secure: mail.implicitTls,
    ...(mail.user === undefined ? {} : { auth: { user: mail.user, pass: mail.password ?? '' } }),
    pool: true,
    maxConnections: 3,
    // A guest is waiting on this; fail fast rather than holding the request open.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });

  return {
    async send(message) {
      await transporter.sendMail({
        from: mail.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    },
  };
}
