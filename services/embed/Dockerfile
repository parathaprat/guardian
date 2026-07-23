# The embedding service.
#
# The model is baked into the image rather than downloaded at boot. It costs
# build time once and saves a two minute cold start on every container start,
# and it means the service comes up identically with no network, which is the
# difference between a stack that runs on a plane and one that does not.

FROM python:3.12-slim

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/app/.cache/huggingface \
    TOKENIZERS_PARALLELISM=false

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

ARG EMBED_MODEL=sentence-transformers/all-MiniLM-L6-v2
ENV EMBED_MODEL=${EMBED_MODEL}
RUN python -c "from sentence_transformers import SentenceTransformer; \
    SentenceTransformer('${EMBED_MODEL}')"

COPY main.py ./

RUN useradd -u 1001 -m app && chown -R app:app /app
USER app

EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')"

# One worker. The model is a few hundred megabytes of resident memory, and a
# second worker would double that to serve a workload that is a handful of
# requests per resolved incident.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
