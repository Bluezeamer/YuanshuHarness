# syntax=docker/dockerfile:1
# 镜像里装的就是 npm 包本身（和 scripts/pack.sh 同一份产出），所以镜像跑通也验证了包结构。
# 基础镜像锁到具体的补丁版本与 Debian 代号；升级时同步更新两处 FROM。

FROM node:24.22.0-bookworm-slim AS pack
# 国内构建换镜像：--build-arg npm_config_registry=https://registry.npmmirror.com
ARG npm_config_registry
WORKDIR /src
COPY . .
# 与 CI 一样：按 package.json 锁定的版本装 pnpm，不依赖 corepack。
RUN npm install -g "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]")" \
 && pnpm install --frozen-lockfile \
 && scripts/pack.sh /out \
 && node -p "require('./packages/server/package.json').dependencies['playwright-core']" > /playwright-version

# 只用来把 tarball 导出到宿主机做核对：docker build --target tarball --output ...
FROM scratch AS tarball
COPY --from=pack /out/ /

FROM node:24.22.0-bookworm-slim
# agent 浏览器：运行库与字体、Chromium 本体都在构建期装好，不依赖运行时联网。放在装 Server 之前，改代码不重下浏览器。
# 国内构建换镜像：DEBIAN_MIRROR 填镜像站根（如 https://mirrors.tuna.tsinghua.edu.cn），
# PLAYWRIGHT_DOWNLOAD_HOST 填 Playwright 的下载镜像，npm_config_registry 同上。
ARG DEBIAN_MIRROR
ARG PLAYWRIGHT_DOWNLOAD_HOST
ARG npm_config_registry
RUN if [ -n "$DEBIAN_MIRROR" ]; then sed -i "s#http://deb.debian.org#$DEBIAN_MIRROR#g" /etc/apt/sources.list.d/debian.sources; fi \
 && apt-get update && apt-get install -y --no-install-recommends \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 libdrm2 libgbm1 \
    libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
    libxfixes3 libxkbcommon0 libxrandr2 fontconfig fonts-wqy-microhei fonts-liberation fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=pack /playwright-version /tmp/playwright-version
# 引擎会把 PLAYWRIGHT_BROWSERS_PATH 改指数据目录，所以浏览器放在数据卷之外，用 YUANSHU_BROWSER 指过去（软链接让路径不随版本号变）。
RUN PLAYWRIGHT_BROWSERS_PATH=/opt/browsers npx --yes "playwright-core@$(cat /tmp/playwright-version)" install chromium --no-shell \
 && ln -s "$(find /opt/browsers -type f -name chrome | head -n 1)" /opt/browsers/chrome \
 && test -x /opt/browsers/chrome \
 && chmod -R a+rX /opt/browsers \
 && rm -rf /tmp/playwright-version /root/.npm
ENV YUANSHU_BROWSER=/opt/browsers/chrome

COPY --from=pack /out/*.tgz /tmp/
RUN npm install -g --omit=dev --no-audit --no-fund /tmp/*.tgz \
 && rm -rf /tmp/*.tgz /root/.npm \
 && mkdir /data \
 && chown node:node /data
ENV YUANSHU_HOST=0.0.0.0 YUANSHU_DATA_DIR=/data
USER node
EXPOSE 7420
# 服务转发出口的默认端口段（YUANSHU_FORWARD_PORTS 可改）：要让用户在自己的浏览器里用环境里的服务，运行时要一并发布
EXPOSE 24100-24199
# 镜像里没有 curl 与 wget，用现成的 node 探测；端口取自 YUANSHU_PORT。
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.YUANSHU_PORT||7420)+'/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
ENTRYPOINT ["yuanshu", "serve"]
