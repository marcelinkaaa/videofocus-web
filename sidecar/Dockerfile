FROM python:3.12-alpine

RUN apk add --no-cache nodejs && \
    pip install --no-cache-dir yt-dlp yt-dlp-ejs pycryptodomex bgutil-ytdlp-pot-provider

COPY server.py /app/server.py

EXPOSE 3001

CMD ["python", "/app/server.py"]
