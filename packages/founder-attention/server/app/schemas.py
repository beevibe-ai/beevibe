from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field


class TweetIn(BaseModel):
    id: str = Field(..., description="Stable tweet id (status id from URL).")
    author_handle: str
    author_name: Optional[str] = None
    author_followers: Optional[int] = None
    text: str
    url: str
    posted_at_iso: Optional[str] = None
    reply_count: Optional[int] = None
    like_count: Optional[int] = None


class RankRequest(BaseModel):
    tweets: list[TweetIn]
    persona_overrides: Optional[dict] = None


class Drafts(BaseModel):
    witty: Optional[str] = None
    insightful: Optional[str] = None
    sincere: Optional[str] = None


class RankedTweet(BaseModel):
    tweet_id: str
    score: int = Field(..., ge=0, le=10)
    why: str
    in_golden_window: bool = False
    drafts: Drafts


class RankResponse(BaseModel):
    results: list[RankedTweet]
    model: str
    cached_input_tokens: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
