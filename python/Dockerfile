# Flip Python HTTP Service
# Bill parsing and plan comparison via pdfplumber + deterministic pricing engine

FROM python:3.12-slim

WORKDIR /app

# Install system deps for pdfplumber/Pillow
RUN apt-get update && apt-get install -y --no-install-recommends \
    libjpeg62-turbo libopenjp2-7 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8080

CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "2", "--timeout", "30", "server:app"]
