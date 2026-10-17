# syntax=docker/dockerfile:1
# 镜像里装的就是 npm 包本身（和 scripts/pack.sh 同一份产出），所以镜像跑通也验证了包结构。
# 基础镜像锁到具体的补丁版本与 Debian 代号；升级时同步更新两处 FROM。

FROM node:24.22.0-bookworm-slim AS pack
WORKDIR /src
COPY . .
# 与 CI 一样：按 package.json 锁定的版本装 pnpm，不依赖 corepack。
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
 && pnpm install --frozen-lockfile \
 && scripts/pack.sh /out

# 只用来把 tarball 导出到宿主机做核对：docker build --target tarball --output ...
FROM scratch AS tarball
COPY --from=pack /out/ /

FROM node:24.22.0-bookworm-slim
COPY --from=pack /out/*.tgz /tmp/
RUN npm install -g --omit=dev --no-audit --no-fund /tmp/*.tgz \
 && rm -rf /tmp/*.tgz /root/.npm \
 && mkdir /data \
 && chown node:node /data
ENV YUANSHU_HOST=0.0.0.0 YUANSHU_DATA_DIR=/data
USER node
EXPOSE 7420
# 镜像里没有 curl 与 wget，用现成的 node 探测；端口取自 YUANSHU_PORT。
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.YUANSHU_PORT||7420)+'/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
ENTRYPOINT ["yuanshu", "serve"]
