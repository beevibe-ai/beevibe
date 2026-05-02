export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const { email, website } = req.body ?? {};

  if (typeof website === 'string' && website.length > 0) {
    return res.status(200).json({ ok: true });
  }

  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return res.status(400).json({ error: 'invalid_email' });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const audienceId = process.env.RESEND_AUDIENCE_ID;
  if (!apiKey || !audienceId) {
    console.error('waitlist: missing RESEND_API_KEY or RESEND_AUDIENCE_ID');
    return res.status(500).json({ error: 'not_configured' });
  }

  const r = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email: email.toLowerCase().trim() }),
  });

  if (!r.ok) {
    const body = await r.text();
    console.error('waitlist: resend error', r.status, body);
    if (r.status === 409 || /already exists/i.test(body)) {
      return res.status(200).json({ ok: true, already: true });
    }
    return res.status(502).json({ error: 'upstream_failure' });
  }

  return res.status(200).json({ ok: true });
}
