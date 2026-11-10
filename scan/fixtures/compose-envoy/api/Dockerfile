FROM envoyproxy/envoy:v1.30 AS envoy

FROM python:3.12-slim
COPY --from=envoy /usr/local/bin/envoy /usr/local/bin/envoy
COPY sidecar.yaml /etc/envoy/sidecar.yaml
COPY app.py /app/app.py
CMD ["python", "/app/app.py"]
