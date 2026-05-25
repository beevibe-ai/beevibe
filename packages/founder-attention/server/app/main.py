from __future__ import annotations

import os

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .agent import rank_and_draft
from .persona import load_persona_text, reload_persona
from .schemas import RankRequest, RankResponse

load_dotenv()

app = FastAPI(title="Founder Attention Agent", version="0.0.1")

origins_raw = os.environ.get("FA_ALLOWED_ORIGINS", "chrome-extension://*,http://localhost:*")
allowed_origins = [o.strip() for o in origins_raw.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex="|".join(o.replace("*", ".*") for o in allowed_origins),
    allow_credentials=False,
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "model": os.environ.get("FA_MODEL", "claude-sonnet-4-6")}


@app.get("/persona")
def get_persona() -> dict:
    return {"yaml": load_persona_text()}


@app.post("/persona/reload")
def post_persona_reload() -> dict:
    return {"yaml": reload_persona()}


@app.post("/api/rank-and-draft", response_model=RankResponse)
def post_rank_and_draft(req: RankRequest) -> RankResponse:
    if not req.tweets:
        raise HTTPException(status_code=400, detail="tweets list is empty")
    if len(req.tweets) > 30:
        raise HTTPException(
            status_code=400,
            detail="batch too large; send 30 or fewer tweets per request",
        )
    try:
        return rank_and_draft(req)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"agent failure: {e}")
