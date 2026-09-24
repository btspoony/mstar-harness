FROM node:22-alpine
RUN addgroup -S reviewer && adduser -S -G reviewer reviewer
WORKDIR /worker
COPY --chown=reviewer:reviewer reviewer-probe.mjs /worker/reviewer-probe.mjs
USER reviewer
ENTRYPOINT ["node", "/worker/reviewer-probe.mjs"]
