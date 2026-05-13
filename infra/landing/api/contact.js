export const config = { runtime: 'edge' };

export default async function handler(request) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // Honeypot — bots fill hidden fields, humans don't.
  if (body.website) {
    return json({ ok: true });
  }

  const email = String(body.email || '').trim().toLowerCase();
  const company = String(body.company || '').trim();
  const context = String(body.context || '').trim();

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) {
    return json({ ok: false, error: 'invalid_email' }, 400);
  }
  if (!company || company.length > 200) {
    return json({ ok: false, error: 'invalid_company' }, 400);
  }
  if (!context || context.length > 1500) {
    return json({ ok: false, error: 'invalid_context' }, 400);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!apiKey) {
    return json({ ok: false, error: 'server_misconfigured' }, 500);
  }

  // 1. Add to the existing Resend audience (non-fatal — 409 on duplicate
  //    email is expected behavior and shouldn't block the notification).
  if (audienceId) {
    try {
      await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ email, first_name: company }),
      });
    } catch {
      // Notification email below is the load-bearing path; swallow.
    }
  }

  // 2. Send notification email — the actual signal we care about.
  //    Both `from` and `to` are env-configurable so deliverability can
  //    improve once the beevibe.ai domain is verified in Resend:
  //      RESEND_FROM_EMAIL=Beevibe <hello@beevibe.ai>
  //      RESEND_NOTIFY_TO=ws2694@columbia.edu
  //    Until then, Resend's free-tier sandbox forbids sending from
  //    onboarding@resend.dev to anything but the account-holder's own
  //    address — which is the gmail the Resend account was registered
  //    with, not the columbia address.
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'Beevibe <onboarding@resend.dev>';
  const notifyTo = process.env.RESEND_NOTIFY_TO || 'songweijia2001@gmail.com';

  const sendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [notifyTo],
      reply_to: email,
      subject: `New B2B lead — ${company}`,
      html: renderEmail({ email, company, context }),
    }),
  });

  if (!sendRes.ok) {
    const errText = await sendRes.text().catch(() => '');
    console.error('resend_send_failed', sendRes.status, errText);
    return json({ ok: false, error: 'send_failed' }, 500);
  }

  return json({ ok: true });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function renderEmail({ email, company, context }) {
  return `
    <div style="font-family:-apple-system,system-ui,sans-serif;line-height:1.5;color:#222">
      <h2 style="margin:0 0 16px;font-size:18px">New B2B inquiry from beevibe.ai</h2>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px">Email</td><td style="padding:4px 0;font-size:14px">${esc(email)}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#666;font-size:13px">Company</td><td style="padding:4px 0;font-size:14px">${esc(company)}</td></tr>
      </table>
      <div style="margin-top:16px;padding:12px 14px;background:#f6f6f6;border-radius:6px;font-size:14px;white-space:pre-wrap">${esc(context)}</div>
      <p style="margin-top:24px;color:#888;font-size:12px">Reply directly to this email — it routes back to ${esc(email)}.</p>
    </div>
  `;
}

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
