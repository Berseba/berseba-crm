# Supabase Auth email delivery (Berseba)

Supabase Auth sends its own emails: signup confirmation, password recovery, email change.
The CRM's own mail (team invites, LGPD export, SLA alerts) does **not** go through it.
That mail uses Resend or the SMTP set in **Admin › E-mail** (`lib/email/roteador.ts`).
The two paths are configured in different places, and one working says nothing about
the other.

## What happened on 2026-10-09

Two people invited to `mayara-morales-cabeleireiros` opened their invite links and
signed up with email and password. Their invite emails arrived, because they went out
through the app's own mail path. The Supabase Auth confirmation email never reached
their Hotmail inboxes. Every login then failed with `400 email_not_confirmed`, and the
screen said "Email ou senha incorretos".

What the production auth logs (project `vdtpyqvqxanoowrmixit`) show for one of them:

| Time (UTC) | Event |
|---|---|
| 20:10:06 – 20:11:34 | `POST /token` → `400 email_not_confirmed` (×4) |
| 20:20:51 | `POST /signup` → 200, `user_confirmation_requested` (1.9 s) |
| 20:21:11, 20:21:24 | `POST /token` → `400 email_not_confirmed` |
| 20:29:13 | `POST /token` → 200 (after the manual fix) |

**What the logs do NOT show is which SMTP Supabase Auth used.** The project's SMTP
settings can only be read with a Supabase personal access token or in the dashboard,
and this session had neither. One sign in the logs: `/signup` answered 200. Supabase's
built-in SMTP refuses addresses outside the Supabase organization's team
("Email address not authorized"), which suggests a custom SMTP may already be set and
the problem is delivery to Microsoft. That is an inference, not a measurement.
Check the dashboard as described below.

## Since this PR

Invite signups no longer depend on this email: the invite confirms the account
(`lib/auth/invite-signup.ts`). Two flows still do depend on it:

- open self-signup without an invite (the confirmation email);
- **"Esqueci minha senha"**, which is the only way back into an account whose password
  was forgotten.

So a broken Auth SMTP still locks people out. It just no longer locks out invitees.

## Check (dashboard, read-only)

1. Supabase dashboard → project `vdtpyqvqxanoowrmixit` → **Authentication › Emails ›
   SMTP Settings**.
2. If **Enable custom SMTP** is off, the project uses Supabase's built-in sender. That
   sender only delivers to members of the Supabase organization and has a tiny hourly
   cap. It is not meant for production. Go to **Set**.
3. If it is on, note the host and sender. If the host is `smtp.resend.com`, open Resend
   → **Emails** and search for the two Hotmail addresses from 2026-10-09. The status
   (delivered, bounced, complained, suppressed) says where the email died. If it says
   *delivered*, Microsoft filtered it. Check the domain's SPF, DKIM and DMARC under
   Resend → **Domains**.

Or with a personal access token (do not paste it into a chat or a commit):

```bash
curl -s "https://api.supabase.com/v1/projects/vdtpyqvqxanoowrmixit/config/auth" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" | jq '{smtp_host, smtp_port, smtp_user, smtp_admin_email, smtp_sender_name, rate_limit_email_sent, mailer_autoconfirm}'
```

## Set (Matheus, in the dashboard)

**Authentication › Emails › SMTP Settings → Enable custom SMTP**, with Resend:

| Field | Value |
|---|---|
| Sender email | an address on a domain **verified in Resend**, e.g. `no-reply@grupoberseba.com.br` (use the same domain as the CRM's `RESEND_FROM`) |
| Sender name | `Berseba CRM` |
| Host | `smtp.resend.com` |
| Port | `465` (or `587`) |
| Username | `resend` |
| Password | a Resend API key with **Sending access** only, created for this. Not the VPS key |

Then:

- **Authentication › Rate Limits → Rate limit for sending emails.** Supabase starts
  custom SMTP at 30 emails per hour. That is enough for this installation today, but
  raise it if signups grow.
- Send yourself a password recovery from `/login/forgot` to a Hotmail/Outlook address,
  and confirm it lands in the inbox (not junk).
- The branded templates (`hostgator-setup-kit/marca-emails.sh`, applied on 2026-10-01)
  are kept. They do not depend on the SMTP choice.

Nothing in the app or the VPS `.env` changes for this: Supabase Auth reads its SMTP
from the project settings, not from our environment.
