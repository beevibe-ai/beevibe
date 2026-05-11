# beevibe.ai landing

Source for the marketing landing page at https://beevibe.ai.

Single static `index.html` plus `assets/`. No build step, no framework —
Tailwind via CDN, Lucide via CDN, fonts via Google Fonts.

## Deploy

Hosted on Vercel as the `landing` project under
`songweijia2001-7315s-projects`. The Vercel project is **not** git-linked
(it's a CLI-deployed project), so changes here do **not** auto-deploy on
merge. To ship a change after merging:

```bash
cd infra/landing
vercel --prod
```

You'll need the Vercel CLI authed to the right scope (`vercel whoami`
should return `songweijia2001-7315`).

If we want auto-deploys later, the move is to git-connect the Vercel
project to this repo with root directory set to `infra/landing/`.

## Editing

- Copy lives inline in `index.html` — no CMS, no templating
- Mascot illustrations in `assets/` are AI-generated (Midjourney) source
  masters preserved in `mocks/` at repo root
- The OG card meta tag hardcodes `https://beevibe.ai/assets/og-card.png`;
  keep that URL valid when reorganizing assets
