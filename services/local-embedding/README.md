# Local Qwen3 Embedding Service

This service keeps embedding inference on the local machine. It is intentionally bound to the loopback interface and exposes a small OpenAI-compatible endpoint used by the Next.js application.

## Setup

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8000
```

The first start downloads `Qwen/Qwen3-Embedding-0.6B` to the local Hugging Face cache. After the weights are cached, normal embedding requests do not leave the machine.

## Application configuration

```text
LOCAL_EMBEDDING_BASE_URL=http://127.0.0.1:8000
LOCAL_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-0.6B
LOCAL_EMBEDDING_TIMEOUT_MS=30000
```

Queries receive the model's retrieval prompt; imported knowledge chunks are encoded as documents without that prompt, following Qwen's official retrieval guidance.

## Security boundary

- Do not bind the service to `0.0.0.0` unless an authenticated local network deployment has been designed.
- Do not place patient texts in the knowledge ingestion directory.
- The service does not make outbound inference requests. Initial model-weight download is the only expected network operation.
