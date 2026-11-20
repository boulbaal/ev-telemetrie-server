# Bouwt Tesla's vehicle-command HTTP-proxy uit de officiële broncode.
# Die proxy ondertekent de telemetrie-configuratie met onze private key.
# Let op: 'go install @latest' werkt niet (replace-regels in go.mod), dus we
# klonen de repo en bouwen van binnenuit.
FROM golang:1.23-alpine AS build
RUN apk add --no-cache git
RUN git clone --depth 1 https://github.com/teslamotors/vehicle-command.git /src
WORKDIR /src
RUN go build -o /out/tesla-http-proxy ./cmd/tesla-http-proxy

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/tesla-http-proxy /usr/local/bin/tesla-http-proxy
# Certificaat en sleutel komen via volumes/omgevingsvariabelen (zie compose).
ENTRYPOINT ["sh", "-c", "tesla-http-proxy -tls-key \"$TESLA_HTTP_PROXY_TLS_KEY\" -cert \"$TESLA_HTTP_PROXY_TLS_CERT\" -key-file \"$TESLA_KEY_FILE\" -host \"$TESLA_HTTP_PROXY_HOST\" -port \"$TESLA_HTTP_PROXY_PORT\""]
