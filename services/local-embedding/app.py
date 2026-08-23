"""Local-only OpenAI-compatible embeddings service for Qwen3-Embedding-0.6B."""

import os
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

MODEL_NAME = os.getenv("QWEN_EMBEDDING_MODEL", "Qwen/Qwen3-Embedding-0.6B")
DEVICE = os.getenv("QWEN_EMBEDDING_DEVICE", "cpu")
MAX_BATCH_SIZE = int(os.getenv("QWEN_EMBEDDING_BATCH_SIZE", "16"))
QUERY_INSTRUCTION = os.getenv(
    "QWEN_EMBEDDING_QUERY_INSTRUCTION",
    "Given a clinician query about head and neck oncology, retrieve relevant "
    "authorized medical knowledge passages.",
)

model: SentenceTransformer | None = None


class EmbeddingRequest(BaseModel):
    model: str = Field(default=MODEL_NAME)
    input: str | list[str]
    input_type: Literal["document", "query"] = "document"


class EmbeddingItem(BaseModel):
    object: str = "embedding"
    index: int
    embedding: list[float]


class EmbeddingResponse(BaseModel):
    object: str = "list"
    model: str
    data: list[EmbeddingItem]


@asynccontextmanager
async def lifespan(_: FastAPI):
    global model
    model = SentenceTransformer(MODEL_NAME, device=DEVICE)
    yield
    model = None


app = FastAPI(title="Local Qwen Embedding Service", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str | bool]:
    return {"ok": model is not None, "model": MODEL_NAME, "device": DEVICE}


@app.post("/v1/embeddings", response_model=EmbeddingResponse)
def create_embeddings(request: EmbeddingRequest) -> EmbeddingResponse:
    if model is None:
        raise HTTPException(status_code=503, detail="Embedding model is not ready")
    if request.model != MODEL_NAME:
        raise HTTPException(status_code=400, detail="Requested model is not served locally")

    texts = [request.input] if isinstance(request.input, str) else request.input
    if not texts or len(texts) > MAX_BATCH_SIZE:
        raise HTTPException(status_code=400, detail=f"input must contain 1-{MAX_BATCH_SIZE} texts")

    # Qwen's official usage applies a retrieval prompt to queries only.
    kwargs = {"normalize_embeddings": True, "show_progress_bar": False}
    if request.input_type == "query":
        vectors = model.encode(texts, prompt=QUERY_INSTRUCTION, **kwargs)
    else:
        vectors = model.encode(texts, **kwargs)

    return EmbeddingResponse(
        model=MODEL_NAME,
        data=[EmbeddingItem(index=index, embedding=vector.tolist()) for index, vector in enumerate(vectors)],
    )
