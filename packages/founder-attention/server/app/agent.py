from __future__ import annotations

import json
import os
import re
from datetime import datetime, time
from typing import Any
from zoneinfo import ZoneInfo

from anthropic import Anthropic

from .persona import load_persona_text, merge_overrides
from .schemas import Drafts, RankedTweet, RankRequest, RankResponse, TweetIn

DEFAULT_MODEL = os.environ.get("FA_MODEL", "claude-sonnet-4-6")

SYSTEM_TEMPLATE = """\
You are Founder Attention Agent — a personal assistant to a startup founder who \
wants strategic engagement on X (Twitter) without doom-scrolling.

You receive a batch of tweets the founder has seen. You do two things:
1. SCORE each tweet 0-10 on engagement value
2. For tweets scoring 6+, DRAFT three reply variants in different voices

The founder will REVIEW EVERY DRAFT before posting. You are NOT an auto-poster. \
Never produce templated or near-identical replies across tweets — that is \
platform manipulation. Variety and substance matter more than volume.

# Founder persona
The persona below drives ranking (what's relevant?) and drafting (what voice?).
Use it as ground truth. If the persona is missing a piece you need, infer \
conservatively and flag low confidence in the `why`.

<persona>
{persona}
</persona>

# Scoring rubric (0-10)
Start every tweet at 5. Adjust:
  +2  author appears in target_audiences (vcs / peers / customers / kols)
  +2  topic clearly in topics_in_scope
  +2  high reply value: question, debate, hot take, asks for input
  +1  recent (<30 min) — first reply still possible
  +1  author follower count in 10k-500k visible-reply zone
  +1  founder has a unique angle from their context
  -3  topic in topics_out_of_scope
  -2  generic motivational / quote / screenshot only
  -2  already >50 replies (will be buried)
  -2  mega-celeb (>5M followers, low chance of being seen)
  -5  any conflict with `avoid` rules

Clamp final score to 0-10.

# Drafting rules (only for score >= 6)
Produce THREE variants per tweet. The three must differ in opening word.

  witty       max 15 words, single sentence. Punchline structure: setup -> \
              unexpected twist. Reference / analogy / dry observation. \
              If no clean angle exists, set this field to null — do not force.
  insightful  2-3 sentences. Substance the OP didn't give: a data point, a \
              missing variable, a specific experience, a defensible \
              contrarian read. Anchor in specifics, not abstractions.
  sincere     1-2 sentences. Reference a SPECIFIC detail of the OP's tweet \
              (proves you read it). Ask a follow-up question or share a \
              parallel. Warm but not sycophantic.

All drafts:
  - Under 280 characters (count chars, not tokens).
  - Never start with "I".
  - No hashtags unless persona's signature_phrases use them.
  - Never use any string in persona.voice.banned_phrases.
  - No politics, no dunking on named competitors, no claims without backing.
  - If persona.product_mention_policy permits and the tweet is directly \
    about the product's space, you MAY mention it once, naturally. Never \
    include the product URL — that reads as spam.

If score < 6, set all three draft fields to null.

# Output format
You will reply with a single JSON object, no prose, no markdown fences. \
Schema:

{{
  "results": [
    {{
      "tweet_id": "<echo input id>",
      "score": <int 0-10>,
      "why": "<one line, <=80 chars, explains the score>",
      "drafts": {{
        "witty": "<string or null>",
        "insightful": "<string or null>",
        "sincere": "<string or null>"
      }}
    }}
  ]
}}

Sort `results` by score descending. Include EVERY input tweet, even low scores."""


def _golden_now(persona_yaml: str) -> bool:
    import yaml

    data = yaml.safe_load(persona_yaml) or {}
    windows = data.get("golden_hours") or []
    if not windows:
        return False
    try:
        tz_name = (data.get("voice") or {}).get("timezone") or "UTC"
        now = datetime.now(ZoneInfo(tz_name)).time()
    except Exception:
        now = datetime.utcnow().time()
    for w in windows:
        try:
            start_s, end_s = w.split("-")
            start = time.fromisoformat(start_s.strip())
            end = time.fromisoformat(end_s.strip())
            if start <= now <= end:
                return True
        except Exception:
            continue
    return False


def _extract_json(raw: str) -> dict[str, Any]:
    # We prefill with "{" so raw should be the body after that.
    # Be defensive in case the model added fences or trailing text.
    text = raw.strip()
    if not text.startswith("{"):
        text = "{" + text
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        raise ValueError(f"No JSON object in model output: {raw[:300]!r}")
    return json.loads(m.group(0))


def rank_and_draft(req: RankRequest) -> RankResponse:
    persona_yaml = merge_overrides(load_persona_text(), req.persona_overrides)
    system_text = SYSTEM_TEMPLATE.format(persona=persona_yaml)

    tweets_payload = [t.model_dump() for t in req.tweets]
    user_msg = (
        "Here are the tweets to score. Return only JSON, per the schema.\n\n"
        + json.dumps({"tweets": tweets_payload}, ensure_ascii=False, indent=2)
    )

    client = Anthropic()
    resp = client.messages.create(
        model=DEFAULT_MODEL,
        max_tokens=4096,
        system=[
            {
                "type": "text",
                "text": system_text,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[
            {"role": "user", "content": user_msg},
            {"role": "assistant", "content": "{"},
        ],
    )

    raw = "".join(
        block.text for block in resp.content if getattr(block, "type", None) == "text"
    )
    parsed = _extract_json(raw)

    in_golden = _golden_now(persona_yaml)
    results: list[RankedTweet] = []
    for item in parsed.get("results", []):
        drafts = item.get("drafts") or {}
        results.append(
            RankedTweet(
                tweet_id=str(item["tweet_id"]),
                score=int(item["score"]),
                why=str(item.get("why", ""))[:80],
                in_golden_window=in_golden,
                drafts=Drafts(
                    witty=drafts.get("witty"),
                    insightful=drafts.get("insightful"),
                    sincere=drafts.get("sincere"),
                ),
            )
        )
    results.sort(key=lambda r: r.score, reverse=True)

    usage = getattr(resp, "usage", None)
    return RankResponse(
        results=results,
        model=DEFAULT_MODEL,
        cached_input_tokens=getattr(usage, "cache_read_input_tokens", 0) or 0,
        input_tokens=getattr(usage, "input_tokens", 0) or 0,
        output_tokens=getattr(usage, "output_tokens", 0) or 0,
    )
