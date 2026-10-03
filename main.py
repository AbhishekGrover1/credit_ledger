"""Credit Ledger — loan default risk API.

FastAPI service around a calibrated XGBoost pipeline.
Serves the static frontend from ./static; exposes /predict and /health.
"""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("credit-ledger")

state: dict = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    t0 = time.perf_counter()
    state["model"] = joblib.load(BASE_DIR / "credit_risk_model.pkl")
    raw = joblib.load(BASE_DIR / "best_threshold.pkl")
    state["threshold"] = float(np.asarray(raw).item())
    elapsed = time.perf_counter() - t0
    log.info("model ready in %.2fs  threshold=%.4f", elapsed, state["threshold"])
    yield
    state.clear()
    log.info("model unloaded")


app = FastAPI(
    title="Credit Ledger",
    version="2.0.0",
    description="Calibrated XGBoost loan default risk scoring API.",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url=None,
)

app.add_middleware(GZipMiddleware, minimum_size=1024)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


# ── input model ─────────────────────────────────────────────────────────────

class LoanApplication(BaseModel):
    """Fields the applicant supplies; all validated before the model sees them."""

    person_age: int = Field(ge=18, le=100, examples=[30])
    person_income: float = Field(gt=0, examples=[600_000])
    person_home_ownership: Literal["RENT", "MORTGAGE", "OWN", "OTHER"]
    person_emp_length: float = Field(ge=0, le=60, examples=[5])
    loan_intent: Literal[
        "PERSONAL", "EDUCATION", "MEDICAL",
        "VENTURE", "HOMEIMPROVEMENT", "DEBTCONSOLIDATION",
    ]
    loan_grade: Literal["A", "B", "C", "D", "E", "F", "G"]
    loan_amnt: float = Field(gt=0, examples=[100_000])
    loan_int_rate: float = Field(ge=0, le=40, examples=[11.5])
    loan_percent_income: Optional[float] = Field(default=None, ge=0, le=1.5)
    cb_person_default_on_file: Literal["Y", "N"]
    cb_person_cred_hist_length: int = Field(ge=0, le=60, examples=[6])

    @model_validator(mode="after")
    def validate_consistency(self):
        work_age = self.person_age - 14
        if self.person_emp_length > work_age:
            raise ValueError("Employment length exceeds what is possible for this age.")
        if self.cb_person_cred_hist_length > work_age:
            raise ValueError("Credit history length exceeds what is possible for this age.")
        if self.loan_percent_income is None:
            self.loan_percent_income = round(self.loan_amnt / self.person_income, 4)
        return self


# ── output model ─────────────────────────────────────────────────────────────

class Prediction(BaseModel):
    default_probability: float
    default_prediction: int          # 0 or 1
    threshold: float
    result: Literal["High Risk", "Low Risk"]


# ── endpoints ────────────────────────────────────────────────────────────────

@app.get("/health", tags=["ops"])
def health():
    """Liveness / readiness probe used by Render and the frontend status chip."""
    if "model" not in state:
        return JSONResponse(status_code=503, content={"status": "loading"})
    return {"status": "ok", "threshold": state["threshold"]}


@app.post("/predict", response_model=Prediction, tags=["inference"])
def predict(application: LoanApplication, request: Request):
    frame = pd.DataFrame([application.model_dump()])
    probability = float(state["model"].predict_proba(frame)[:, 1][0])
    flagged = int(probability >= state["threshold"])
    log.info(
        "predict  ip=%-15s  prob=%.3f  decision=%s",
        request.client.host if request.client else "unknown",
        probability,
        "HIGH" if flagged else "low",
    )
    return Prediction(
        default_probability=probability,
        default_prediction=flagged,
        threshold=state["threshold"],
        result="High Risk" if flagged else "Low Risk",
    )


# ── global error handler ─────────────────────────────────────────────────────

@app.exception_handler(Exception)
async def unhandled_exception(_: Request, exc: Exception):
    log.exception("unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Internal server error."})


# ── static files (must be last) ───────────────────────────────────────────────

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
