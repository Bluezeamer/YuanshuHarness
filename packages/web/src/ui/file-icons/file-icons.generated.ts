// 由 scripts/gen-file-icons.mjs 生成，不要手改。改映射请编辑 mapping.json 后重新生成。
// 图标：Catppuccin Icons（MIT，Copyright (c) 2023 Catppuccin、thang-nm），
// 取自 @iconify-json/catppuccin@1.2.17；许可证全文见仓库 licenses/Catppuccin-icons.txt。
// 颜色是 var(--ci-*)，取值在 ui/tokens.css。

export const MAPPING = {
  files: {
    "package.json": "package-json",
    "package-lock.json": "npm-lock",
    "pnpm-lock.yaml": "pnpm-lock",
    "pnpm-workspace.yaml": "pnpm",
    "yarn.lock": "yarn-lock",
    "bun.lock": "bun-lock",
    "bun.lockb": "bun-lock",
    "cargo.toml": "cargo",
    "cargo.lock": "cargo-lock",
    "go.mod": "go-mod",
    "go.sum": "go-mod",
    dockerfile: "docker",
    ".dockerignore": "docker-ignore",
    "docker-compose.yml": "docker-compose",
    "docker-compose.yaml": "docker-compose",
    "compose.yml": "docker-compose",
    "compose.yaml": "docker-compose",
    makefile: "makefile",
    "cmakelists.txt": "cmake",
    justfile: "just",
    readme: "readme",
    "readme.md": "readme",
    "readme.txt": "readme",
    license: "license",
    "license.md": "license",
    "license.txt": "license",
    "changelog.md": "changelog",
    "contributing.md": "contributing",
    "code_of_conduct.md": "code-of-conduct",
    "todo.md": "todo",
    ".gitignore": "git",
    ".gitattributes": "git",
    ".gitmodules": "git",
    ".env": "env",
    ".editorconfig": "editorconfig",
    ".prettierignore": "prettier-ignore",
    ".eslintignore": "eslint-ignore",
    ".npmrc": "npm",
    ".npmignore": "npm-ignore",
    "biome.json": "biome",
    "biome.jsonc": "biome",
    "tsconfig.json": "typescript-config",
    "robots.txt": "robots",
    "favicon.ico": "favicon",
    ".gitlab-ci.yml": "gitlab",
    "pyproject.toml": "python-config",
    "requirements.txt": "python-config",
    "uv.lock": "uv",
    "poetry.lock": "lock",
  },
  prefixes: [
    [".env.", "env"],
    ["tsconfig.", "typescript-config"],
    ["dockerfile.", "docker"],
    ["readme.", "readme"],
    ["license.", "license"],
    ["vite.config.", "vite"],
    ["vitest.config.", "vitest"],
    ["tailwind.config.", "tailwind"],
    ["jest.config.", "jest"],
    ["eslint.config.", "eslint"],
    [".eslintrc", "eslint"],
    ["prettier.config.", "prettier"],
    [".prettierrc", "prettier"],
    ["webpack.config.", "webpack"],
    ["rollup.config.", "rollup"],
  ],
  suffixes: [
    [".d.ts", "typescript-def"],
    [".test.ts", "typescript-test"],
    [".spec.ts", "typescript-test"],
    [".test.tsx", "typescript-test"],
    [".spec.tsx", "typescript-test"],
    [".test.js", "javascript-test"],
    [".spec.js", "javascript-test"],
    [".test.jsx", "javascript-test"],
    [".config.ts", "typescript-config"],
    [".config.js", "javascript-config"],
    [".config.mjs", "javascript-config"],
    [".config.cjs", "javascript-config"],
    [".js.map", "javascript-map"],
    [".css.map", "css-map"],
  ],
  exts: {
    ts: "typescript",
    mts: "typescript",
    cts: "typescript",
    tsx: "typescript-react",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript-react",
    json: "json",
    jsonc: "json",
    json5: "json",
    py: "python",
    pyi: "python",
    pyc: "python-compiled",
    rs: "rust",
    go: "go",
    java: "java",
    jar: "java-jar",
    class: "java-class",
    kt: "kotlin",
    kts: "kotlin",
    swift: "swift",
    gradle: "gradle",
    groovy: "groovy",
    c: "c",
    h: "c-header",
    cc: "cpp",
    cpp: "cpp",
    cxx: "cpp",
    hpp: "cpp-header",
    hh: "cpp-header",
    cs: "csharp",
    rb: "ruby",
    php: "php",
    lua: "lua",
    dart: "dart",
    r: "r",
    jl: "julia",
    zig: "zig",
    hs: "haskell",
    ex: "elixir",
    exs: "elixir",
    scala: "scala",
    pl: "perl",
    pm: "perl",
    ml: "ocaml",
    clj: "clojure",
    erl: "erlang",
    elm: "elm",
    nim: "nim",
    sol: "solidity",
    asm: "assembly",
    cu: "cuda",
    glsl: "shader",
    frag: "shader",
    vert: "shader",
    sql: "database",
    db: "database",
    sqlite: "database",
    sqlite3: "database",
    md: "markdown",
    markdown: "markdown",
    mdx: "markdown-mdx",
    txt: "text",
    log: "log",
    org: "org",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    xsl: "xml",
    ini: "config",
    cfg: "config",
    conf: "config",
    properties: "properties",
    env: "env",
    html: "html",
    htm: "html",
    css: "css",
    scss: "sass",
    sass: "sass",
    less: "less",
    vue: "vue",
    svelte: "svelte",
    astro: "astro",
    graphql: "graphql",
    gql: "graphql",
    prisma: "prisma",
    svg: "svg",
    png: "image",
    jpg: "image",
    jpeg: "image",
    gif: "image",
    webp: "image",
    bmp: "image",
    ico: "image",
    avif: "image",
    mp3: "audio",
    wav: "audio",
    flac: "audio",
    ogg: "audio",
    m4a: "audio",
    mp4: "video",
    mov: "video",
    mkv: "video",
    webm: "video",
    avi: "video",
    pdf: "pdf",
    csv: "csv",
    tsv: "csv",
    xls: "ms-excel",
    xlsx: "ms-excel",
    doc: "ms-word",
    docx: "ms-word",
    ppt: "ms-powerpoint",
    pptx: "ms-powerpoint",
    zip: "zip",
    tar: "zip",
    gz: "zip",
    tgz: "zip",
    bz2: "zip",
    xz: "zip",
    "7z": "zip",
    rar: "zip",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "bash",
    ps1: "powershell",
    bat: "batch",
    cmd: "batch",
    lock: "lock",
    key: "key",
    pem: "certificate",
    crt: "certificate",
    cer: "certificate",
    ttf: "font",
    otf: "font",
    woff: "font",
    woff2: "font",
    exe: "exe",
    dll: "binary",
    so: "binary",
    dylib: "binary",
    bin: "binary",
    o: "binary",
    wasm: "web-assembly",
    ipynb: "jupyter",
    tex: "latex",
    proto: "proto",
    tf: "terraform",
    nix: "nix",
    diff: "diff",
    patch: "diff",
    http: "http",
    vim: "vim",
    mmd: "mermaid",
    mermaid: "mermaid",
    drawio: "drawio",
    rmd: "rmd",
  },
  dirs: {
    ".git": "git",
    ".github": "github",
    ".gitlab": "gitlab",
    ".vscode": "vscode",
    ".husky": "husky",
    node_modules: "node",
    src: "src",
    lib: "lib",
    app: "app",
    api: "api",
    docs: "docs",
    doc: "docs",
    test: "tests",
    tests: "tests",
    __tests__: "tests",
    spec: "tests",
    scripts: "scripts",
    script: "scripts",
    config: "config",
    configs: "config",
    ".config": "config",
    dist: "dist",
    build: "dist",
    out: "dist",
    public: "public",
    assets: "assets",
    asset: "assets",
    components: "components",
    component: "components",
    hooks: "hooks",
    utils: "utils",
    util: "utils",
    types: "types",
    images: "images",
    image: "images",
    img: "images",
    fonts: "fonts",
    font: "fonts",
    styles: "styles",
    style: "styles",
    tmp: "temp",
    temp: "temp",
    server: "server",
    client: "client",
    core: "core",
    shared: "shared",
    plugins: "plugins",
    routes: "routes",
    views: "views",
    layouts: "layouts",
    middleware: "middleware",
    mocks: "mocks",
    templates: "templates",
    themes: "themes",
    locales: "locales",
    i18n: "locales",
    packages: "packages",
    examples: "examples",
    coverage: "coverage",
    docker: "docker",
    database: "database",
    db: "database",
    workflows: "workflows",
    kubernetes: "kubernetes",
    k8s: "kubernetes",
    include: "include",
    private: "private",
    download: "download",
    audio: "audio",
    video: "video",
  },
  defaults: {
    file: "file",
    dir: "folder",
  },
  dirIcons: [
    "folder",
    "folder-api",
    "folder-api-open",
    "folder-app",
    "folder-app-open",
    "folder-assets",
    "folder-assets-open",
    "folder-audio",
    "folder-audio-open",
    "folder-client",
    "folder-client-open",
    "folder-components",
    "folder-components-open",
    "folder-config",
    "folder-config-open",
    "folder-core",
    "folder-core-open",
    "folder-coverage",
    "folder-coverage-open",
    "folder-database",
    "folder-database-open",
    "folder-dist",
    "folder-dist-open",
    "folder-docker",
    "folder-docker-open",
    "folder-docs",
    "folder-docs-open",
    "folder-download",
    "folder-download-open",
    "folder-examples",
    "folder-examples-open",
    "folder-fonts",
    "folder-fonts-open",
    "folder-git",
    "folder-git-open",
    "folder-github",
    "folder-github-open",
    "folder-gitlab",
    "folder-gitlab-open",
    "folder-hooks",
    "folder-hooks-open",
    "folder-husky",
    "folder-husky-open",
    "folder-images",
    "folder-images-open",
    "folder-include",
    "folder-include-open",
    "folder-kubernetes",
    "folder-kubernetes-open",
    "folder-layouts",
    "folder-layouts-open",
    "folder-lib",
    "folder-lib-open",
    "folder-locales",
    "folder-locales-open",
    "folder-middleware",
    "folder-middleware-open",
    "folder-mocks",
    "folder-mocks-open",
    "folder-node",
    "folder-node-open",
    "folder-open",
    "folder-packages",
    "folder-packages-open",
    "folder-plugins",
    "folder-plugins-open",
    "folder-private",
    "folder-private-open",
    "folder-public",
    "folder-public-open",
    "folder-routes",
    "folder-routes-open",
    "folder-scripts",
    "folder-scripts-open",
    "folder-server",
    "folder-server-open",
    "folder-shared",
    "folder-shared-open",
    "folder-src",
    "folder-src-open",
    "folder-styles",
    "folder-styles-open",
    "folder-temp",
    "folder-temp-open",
    "folder-templates",
    "folder-templates-open",
    "folder-tests",
    "folder-tests-open",
    "folder-themes",
    "folder-themes-open",
    "folder-types",
    "folder-types-open",
    "folder-utils",
    "folder-utils-open",
    "folder-video",
    "folder-video-open",
    "folder-views",
    "folder-views-open",
    "folder-vscode",
    "folder-vscode-open",
    "folder-workflows",
    "folder-workflows-open",
  ],
} as const;

export const ICONS: Readonly<Record<string, string>> = {
  assembly:
    '<rect width="8" height="13.001" x="4" y="1.499" fill="none" stroke-linecap="round" stroke-linejoin="round" rx="2.286" ry="2.286" style="stroke:var(--ci-text)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4 4.5H1.5M4 8H1.5M4 11.5H1.5m13-7H12M14.5 8H12m2.5 3.5H12" style="stroke:var(--ci-text)"/>',
  astro:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.561 1.61L13.5 10.5c-.995-.517-2.395-1.298-3.5-1.493L8 3.5L6 9.007c-1.11.194-2.5.974-3.5 1.493l3.163-8.891c.121-.398.182-.597.302-.745A1 1 0 0 1 6.36.57c.176-.07.384-.07.8-.07h1.902c.416 0 .625 0 .801.071a1 1 0 0 1 .396.293c.12.148.18.347.301.746" style="stroke:var(--ci-text)"/><path d="M10.411 11.266c-.43.365-1.292.613-2.283.613c-1.217 0-2.237-.374-2.508-.879a2.8 2.8 0 0 0-.119.831s-.063 1.038.666 1.76c0-.374.307-.679.686-.679c.648 0 .648.561.647 1.016v.04c0 .691.426 1.282 1.032 1.532a1.4 1.4 0 0 1-.141-.61c0-.658.39-.903.845-1.188c.36-.227.761-.479 1.038-.985a1.84 1.84 0 0 0 .137-1.451" style="stroke:var(--ci-mauve)"/></g>',
  audio:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-maroon)"><path d="M5.5 12.5a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2a2 2 0 0 1 2 2m9-2a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2a2 2 0 0 1 2 2"/><path d="M5.5 12.5V5c0-.54.44-1.21 1.35-1.5l6.3-2c.9 0 1.35.88 1.35 1.5v7.58m-9-3.08l9-3"/></g>',
  bash: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-green)"><path d="M2 15.5c-.7 0-1.5-.8-1.5-1.5V5c0-.7.8-1.5 1.5-1.5h9c.7 0 1.5.8 1.5 1.5v9c0 .7-.8 1.5-1.5 1.5z"/><path d="m1.2 3.8l3.04-2.5S5.17.5 5.7.5h8.4c.66 0 1.4.73 1.4 1.4v7.73a2.7 2.7 0 0 1-.7 1.75l-2.68 3.51"/><path d="M6 8.75c0-.69-.54-1.25-1.2-1.25h-.6c-.66 0-1.2.56-1.2 1.25S3.54 10 4.2 10h.6c.66 0 1.2.56 1.2 1.25s-.54 1.25-1.2 1.25h-.6c-.66 0-1.2-.56-1.2-1.25M4.5 6.5v1m0 5v1"/></g>',
  batch:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-blue)"><path d="M2 15.5c-.7 0-1.5-.8-1.5-1.5V5c0-.7.8-1.5 1.5-1.5h9c.7 0 1.5.8 1.5 1.5v9c0 .7-.8 1.5-1.5 1.5z"/><path d="m1.2 3.8l3.04-2.5S5.17.5 5.7.5h8.4c.66 0 1.4.73 1.4 1.4v7.73a2.7 2.7 0 0 1-.7 1.75l-2.68 3.51M3 8.5l3 2l-3 2"/></g>',
  binary:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-text)"><path d="M3.5 1.5h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2"/><path d="M10.5 9.5h1v3.05M6 9.5h1c.28 0 .5.22.5.5v2a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5v-2c0-.28.22-.5.5-.5m4-6h1c.28 0 .5.22.5.5v2a.5.5 0 0 1-.5.5h-1a.5.5 0 0 1-.5-.5V4c0-.28.22-.5.5-.5m-4.5 0h1v3.05"/></g>',
  biome:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M3.538 12.543C4.37 11.165 5.328 10.297 8 11l.5-2.5c-1.897-.447-4.05-.218-5.58.991a6.38 6.38 0 0 0-2.42 5h15L8 1.51L5 6.5" style="stroke:var(--ci-blue)"/>',
  "bun-lock":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M15 11.51c.28 0 .5.23.5.5v3a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-3c0-.27.22-.5.5-.5zm-4 0v-1.5a1.5 1.5 0 1 1 3 0v1.5" style="stroke:var(--ci-overlay)"/><path d="M14.5 7.01c0-3.69-4.2-5.57-7-6.5c-2.8.93-7 2.81-7 6.5c0 4.85 5.13 5.5 7 5.5" style="stroke:var(--ci-rosewater)"/><path d="M5.5 8.51h4c-.67.67-1.33 1-2 1s-1.33-.33-2-1" style="stroke:var(--ci-maroon)"/><path d="M5 6.51a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m5 0a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1" style="stroke:var(--ci-text)"/></g>',
  c: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.056 12.952a7.05 7.05 0 0 0 9.944 0l-1.79-1.783a4.513 4.513 0 0 1-6.364 0a4.47 4.47 0 0 1 0-6.338a4.513 4.513 0 0 1 6.364 0l.895-.891l.895-.892a7.05 7.05 0 0 0-9.944 0a6.98 6.98 0 0 0 0 9.904" clip-rule="evenodd" style="stroke:var(--ci-blue)"/>',
  "c-header":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.056 12.952a7.05 7.05 0 0 0 9.944 0l-1.79-1.783a4.513 4.513 0 0 1-6.364 0a4.47 4.47 0 0 1 0-6.338a4.513 4.513 0 0 1 6.364 0l.895-.891l.895-.892a7.05 7.05 0 0 0-9.944 0a6.98 6.98 0 0 0 0 9.904" clip-rule="evenodd" style="stroke:var(--ci-mauve)"/>',
  cargo:
    '<g fill="none" fill-rule="evenodd" stroke-linejoin="round" style="stroke:var(--ci-peach)"><path stroke-linecap="round" d="M1.5 7L8 10.5L14.5 7m-10-2.5l3.503 2L14.498 3M4.5 5.5v7m3.5-6V14"/><path stroke-linecap="round" d="M8.003 3L11.5 4.5v8"/><path stroke-linecap="square" d="M1.5 6.984V11l6.503 3.5L14.5 11V3L11 1.5l-6.5 3v1z"/></g>',
  "cargo-lock":
    '<g fill="none" fill-rule="evenodd"><path d="M14.998 11.5a.5.5 0 0 1 .5.5v2.999a.5.5 0 0 1-.5.5H10a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5zM11 11.5V10a1.5 1.5 0 0 1 3 0v1.5" style="stroke:var(--ci-overlay)"/><path stroke-linecap="round" stroke-linejoin="round" d="m.5 6l6 2.996l6-3.498m-9-2.001l3 2.003L12.498 2M3.5 4v7m3-5.502V12.5" style="stroke:var(--ci-peach)"/><path stroke-linecap="round" stroke-linejoin="round" d="M6.499 2.5L9.5 4v3" style="stroke:var(--ci-peach)"/><path stroke-linecap="round" stroke-linejoin="round" d="M12.498 5.5V2L9.538.5L3.5 3.5v.997l-3 1.501v3.54l6 2.962" style="stroke:var(--ci-peach)"/></g>',
  certificate:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9a2 2 0 1 0 0-4a2 2 0 0 0 0 4" style="stroke:var(--ci-yellow)"/><path d="M9.86 2.5h.89c.97 0 1.75.78 1.75 1.75v.9m0 3.72v.88c0 .97-.78 1.75-1.75 1.75m-5.5 0c-.97 0-1.75-.78-1.75-1.75v-.88m0-3.73v-.89c0-.97.78-1.75 1.75-1.75h.89" style="stroke:var(--ci-red)"/><path d="m12.5 5.14l.63.62c.68.69.68 1.8 0 2.48l-.64.63M10.5 11.5V15L8 13l-2.5 2v-3.5m-2-2.64l-.63-.62a1.75 1.75 0 0 1 0-2.48l.63-.62M6.13 2.5l.63-.63c.69-.68 1.8-.68 2.48 0l.62.63" style="stroke:var(--ci-red)"/></g>',
  changelog:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M2.71 10.96a6.5 6.5 0 1 0-.69-3.53M2 8l1.5-1.5M2 8L.5 6.5m8 2v-4m0 4h3" style="stroke:var(--ci-teal)"/>',
  clojure:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M14.17 10.03A6.5 6.5 0 0 1 1.81 6.02" style="stroke:var(--ci-green)"/><path d="M1.87 5.85A6.5 6.5 0 0 1 14.22 9.9" style="stroke:var(--ci-blue)"/><path d="M6.36 4.9a3.5 3.5 0 1 0 3.41 6.12" style="stroke:var(--ci-green)"/><path d="M9.77 11.02a3.5 3.5 0 0 0-3.03-6.29" style="stroke:var(--ci-blue)"/><path d="M8 7.5s-1.66 2.48-1.5 3.65" style="stroke:var(--ci-text)"/><path d="M1.81 6.02C2.47 5 3.83 4.49 5 4.46c4.06 0 3 5.56 5.03 6.86c1.21.52 3.5-.21 4.15-1.32" style="stroke:var(--ci-text)"/></g>',
  cmake:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m6 11.5l-3.5 3H13Z" style="stroke:var(--ci-green)"/><path d="m9 1.5l5.5 11l-4.5-2z" style="stroke:var(--ci-red)"/><path d="m1.5 12.5l6-5l-.5-6Z" style="stroke:var(--ci-blue)"/></g>',
  "code-of-conduct":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-pink)"><path d="M13.42 8.93L8.01 14.5L2.59 8.93a3.85 3.85 0 0 1-.93-3.8A3.55 3.55 0 0 1 8 4.01a3.55 3.55 0 0 1 6.34 1.14c.4 1.34.05 2.8-.92 3.79"/><path d="M8 4L5.72 6.53a.77.77 0 0 0 0 1.06l.4.4c.5.52 1.21.55 1.7.02l.74-.8a2.25 2.25 0 0 1 3.25 0l1.62 1.68m-5.05 2.25l1.44 1.5m.36-3.38l1.45 1.5"/></g>',
  config:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.711" d="M7.997 9.694a1.726 1.695 0 1 0 0-3.39a1.726 1.695 0 0 0 0 3.39m3.021-6.78l3.021 5.085l-3.021 5.085H4.976L1.955 7.999l3.021-5.085z" style="stroke:var(--ci-overlay)"/>',
  contributing:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8.128 14.499h-4.81c-.386 0-.818-.432-.818-.818V2.317c0-.385.432-.817.817-.817h9.37c.385 0 .817.432.817.817v6.866m-8-3.683H10.5m-5 4h3" style="stroke:var(--ci-text)"/><path d="m9.5 12.5l2 2l4-4" style="stroke:var(--ci-green)"/></g>',
  cpp: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M2.556 12.952a7.05 7.05 0 0 0 9.944 0l-1.79-1.783a4.513 4.513 0 0 1-6.364 0a4.47 4.47 0 0 1 0-6.338a4.513 4.513 0 0 1 6.364 0l.895-.891l.895-.892a7.05 7.05 0 0 0-9.944 0a6.98 6.98 0 0 0 0 9.904" clip-rule="evenodd" style="stroke:var(--ci-blue)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M7.5 6v4M5.514 8h3.999m3.973-2v4M11.5 8h4" style="stroke:var(--ci-blue)"/>',
  "cpp-header":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M2.556 12.952a7.05 7.05 0 0 0 9.944 0l-1.79-1.783a4.513 4.513 0 0 1-6.364 0a4.47 4.47 0 0 1 0-6.338a4.513 4.513 0 0 1 6.364 0l.895-.891l.895-.892a7.05 7.05 0 0 0-9.944 0a6.98 6.98 0 0 0 0 9.904" clip-rule="evenodd" style="stroke:var(--ci-mauve)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M7.5 6v4M5.514 8h3.999m3.973-2v4M11.5 8h4" style="stroke:var(--ci-mauve)"/>',
  csharp:
    '<path fill="none" d="M6.666 1.01a1 1 0 0 1 .822 1.15L7.18 3.999h2.972l.36-2.165a1 1 0 0 1 1.971.328l-.303 1.837H14a.999.999 0 1 1 0 2h-2.153l-.666 4H13a.999.999 0 1 1 0 2h-2.153l-.36 2.166a1 1 0 0 1-1.971-.328l.306-1.834H5.847l-.36 2.165a1 1 0 0 1-1.971-.328L3.819 12H2a.999.999 0 1 1 0-2h2.153l.666-4H3a.999.999 0 1 1 0-2h2.153l.36-2.166a1 1 0 0 1 1.15-.822Zm.18 4.988l-.665 4h2.972l.666-4Z" style="stroke:var(--ci-blue)"/>',
  css: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-mauve)"><path d="M4 1.5h8A2.5 2.5 0 0 1 14.5 4v8a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.5 12V4A2.5 2.5 0 0 1 4 1.5"/><path stroke-width=".814" d="M10.24 11.53c0 .58.438 1.038.96 1.035l.453-.004c.522-.003.949-.451.949-1.033c0-.58-.427-1.065-.95-1.065h-.451c-.523 0-.95-.486-.95-1.066s.427-1.038.95-1.038h.452c.522 0 .951.458.951 1.039M6.8 11.529c0 .58.438 1.04.96 1.036l.465-.004c.523-.003.936-.451.936-1.031s-.409-1.066-.931-1.066h-.47c-.522 0-.949-.485-.949-1.066c0-.58.427-1.037.95-1.037h.451c.523 0 .964.457.964 1.037M3.407 11.53c0 .58.438 1.052.96 1.052h.452c.522 0 .95-.457.95-1.038m.01-2.131c0-.58-.437-1.038-.96-1.038h-.451c-.523 0-.96.468-.96 1.05v2.118"/></g>',
  "css-map":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M.5 4.06c0 .77.24 1.52.7 2.13l2.24 3.96l.04.08h0c.13.17.32.27.52.27s.36-.09.48-.23h0l.03-.03l.08-.15l2.2-3.88c.46-.61.71-1.37.71-2.15A3.63 3.63 0 0 0 3.88.5C1.95.5.5 2.1.5 4.06" style="stroke:var(--ci-red)"/><path d="M5.5 4A1.5 1.5 0 0 1 4 5.5A1.5 1.5 0 0 1 2.5 4A1.5 1.5 0 0 1 4 2.5A1.5 1.5 0 0 1 5.5 4" style="stroke:var(--ci-red)"/><path d="M10 3.5h5.5l-1.27 9.8L10 15l-4.23-1.7L5.6 12" style="stroke:var(--ci-blue)"/><path d="M9.46 5.5h3.08L12 11l-2 1l-2-1l-.05-.5m.55-2h3.62" style="stroke:var(--ci-text)"/></g>',
  csv: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M1.5 3.5c0-.54.48-1 1.08-1H6.5l1.54 1h5.38c.6 0 1.08.44 1.08.98l-.09 9.04c0 .54-.48.98-1.08.98H2.58c-.6 0-1.08-.44-1.08-.98zm2 4v4m3-4v4m3-4v4m3-4v4m-9 0h9m-9-2h9m-9-2h9" style="stroke:var(--ci-green)"/>',
  cuda: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-green)"><path d="M13.46 9C9.5 12 3.5 13 .5 8c3.53-4.5 7-4.5 11-.5c-.62.65-4.52 3.9-8.5.5c0 0 2.5-3 5.5-.5c0 0-1.05.59-1.5.75"/><path d="M4.5 4.8V2.5h11v11h-11v-2.3"/></g>',
  dart: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-sapphire)"><path d="M7 14.5h4.5v-3h3V7L9.17 1.64c-.28-.29-.8-.47-1.17-.29L3.5 3.5L1.35 8c-.18.37 0 .88.3 1.17z"/><path d="M3.5 11V3.5H11m-7.5 0l8 8"/></g>',
  database:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M8 6.5c3.59 0 6.5-1.4 6.5-2.68S11.59 1.5 8 1.5S1.5 2.54 1.5 3.82S4.41 6.5 8 6.5M14.5 8c0 .83-1.24 1.79-3.25 2.2s-4.49.41-6.5 0S1.5 8.83 1.5 8m13 4.18c0 .83-1.24 1.6-3.25 2c-2.01.42-4.49.42-6.5 0c-2.01-.4-3.25-1.17-3.25-2m0-8.3v8.3m13-8.3v8.3" style="stroke:var(--ci-yellow)"/>',
  diff: '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10 6H6m2-2v4" style="stroke:var(--ci-green)"/><path d="M10 11.5H6" style="stroke:var(--ci-red)"/><path d="M6.1.5h3.8c1.44 0 2.6 1.09 2.6 2.43v10.14c0 1.34-1.16 2.43-2.6 2.43H6.1c-1.44 0-2.6-1.09-2.6-2.43V2.93C3.5 1.6 4.66.5 6.1.5" style="stroke:var(--ci-text)"/></g>',
  docker:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M.5 8.5H11l.75-.5a5.35 5.35 0 0 1 0-3.5c1 .6 1 1.88 1.74 2c.77-.09 1.23.01 2 .52c0 0-.97 1.77-2.5 1.98c-1.93 3.65-4.5 5.5-6.98 5.5C0 14.5.5 8.5.5 8.5m1 0v-2m0 0h8m-6 2v-4m0 0h4m-2-2h2m-2 6v-6m2 6v-6m2 6v-2" style="stroke:var(--ci-blue)"/>',
  "docker-compose":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M.5 8.5H11l.75-.5a5.35 5.35 0 0 1 0-3.5c1 .6 1 1.88 1.74 2c.77-.09 1.23.01 2 .52c0 0-.97 1.77-2.5 1.98c-1.93 3.65-4.5 5.5-6.98 5.5C0 14.5.5 8.5.5 8.5m1 0v-2m0 0h8m-6 2v-4m0 0h4m-2-2h2m-2 6v-6m2 6v-6m2 6v-2" style="stroke:var(--ci-teal)"/>',
  "docker-ignore":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M.5 8.5H11l.75-.5a5.35 5.35 0 0 1 0-3.5c1 .6 1 1.88 1.74 2c.77-.09 1.23.01 2 .52c0 0-.97 1.77-2.5 1.98c-1.93 3.65-4.5 5.5-6.98 5.5C0 14.5.5 8.5.5 8.5m1 0v-2m0 0h8m-6 2v-4m0 0h4m-2-2h2m-2 6v-6m2 6v-6m2 6v-2" style="stroke:var(--ci-overlay)"/>',
  drawio:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M2.25 10.5h3.5c.41 0 .75.34.75.75v2.5c0 .41-.34.75-.75.75h-3.5a.75.75 0 0 1-.75-.75v-2.5c0-.41.34-.75.75-.75m8 0h3.5c.41 0 .75.34.75.75v2.5c0 .41-.34.75-.75.75h-3.5a.75.75 0 0 1-.75-.75v-2.5c0-.41.34-.75.75-.75m-4-9h3.5c.41 0 .75.34.75.75v2.5c0 .41-.34.75-.75.75h-3.5a.75.75 0 0 1-.75-.75v-2.5c0-.41.34-.75.75-.75M4 10.5l3.5-5m4.5 5l-3.5-5" style="stroke:var(--ci-peach)"/>',
  editorconfig:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M3.86 6.46c.23.08.46.15.66.28a2 2 0 0 1 .66.6c.1.15.17.35.15.53a.8.8 0 0 1-.29.53c-.2.16-.5.14-.74.15a3.9 3.9 0 0 1-1.5-.32a3.5 3.5 0 0 1-.64-.31c-.18-.12-.44-.25-.55-.45A.73.73 0 0 1 1.5 7c.02-.18.1-.4.24-.51c.18-.16.49-.2.72-.23a4.3 4.3 0 0 1 1.4.2m4.05 1.7c.23.05.47.1.7.17c.24.08.5.15.72.3c.17.13.38.27.45.48c.05.15.02.65-.05.8a.97.97 0 0 1-.37.39a1.4 1.4 0 0 1-.6.2c-.18.03-.37-.03-.56-.05c-.25-.04-.5-.07-.73-.13c-.27-.07-.56-.13-.8-.28c-.17-.1-.32-.24-.43-.4a.9.9 0 0 1-.11-.33a2.8 2.8 0 0 1 0-.74c.03-.1.1-.2.19-.27c.1-.1.23-.18.37-.21c.19-.06.39-.03.58-.02c.22.02.43.06.64.1zM3.59 6.04s.3-.61.52-.85a4.1 4.1 0 0 1 3.17-.97a4.25 4.25 0 0 1 2 .7c.24.18.47.4.67.64a5.4 5.4 0 0 1 1.04 2.02c.08.34.12.7.1 1.06a5.3 5.3 0 0 1-.56 1.86c-.11.21-.25.4-.39.6a7.3 7.3 0 0 1-2.29 2.17c-.5.3-1.04.53-1.58.73c-.53.2-1.06.4-1.62.47c-.4.05-.81.06-1.2-.02a2.6 2.6 0 0 1-.98-.43a2.7 2.7 0 0 1-.8-1.08a2.9 2.9 0 0 1-.17-1.04c0-.16 0-.32.02-.47c.02-.2.03-.4.07-.6a9 9 0 0 1 .95-2.34m2.49-4c-.02-.19-.06-.37-.06-.56c0-.22.02-.45.07-.66c.04-.13.1-.25.16-.37c.08-.15.17-.3.28-.42c.12-.15.27-.26.42-.38c.12-.1.23-.2.37-.27a2.6 2.6 0 0 1 1.02-.32c.13 0 .26 0 .39.02a1.08 1.08 0 0 1 .62.41c.09.12.17.25.2.4c.02.09.01.2 0 .3c-.02.19-.06.38-.13.57c-.04.1-.1.21-.16.31c-.12.22-.27.42-.4.62m3.07 2.45s.33-.5.55-.67c.2-.17.43-.3.68-.37c.36-.09.75-.1 1.1-.01a1.66 1.66 0 0 1 1.2 1.22a1.88 1.88 0 0 1-.11 1.42c-.19.33-.5.57-.79.8a3 3 0 0 1-1.6.72c-.23.04-.71.02-.71.02" style="stroke:var(--ci-rosewater)"/>',
  elixir:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M8.03 14.5C5 14.5 3.5 12.49 3.5 10.01c0-2.82 2.25-7.02 4.62-8.48a.24.24 0 0 1 .24 0c.08.04.12.12.11.2c-.13 1.25.22 2.5.98 3.54c.3.43.63.8 1.02 1.27c.54.66.94 1.03 1.52 2.08l.01.02c.33.56.5 1.2.5 1.84c0 2.03-1.69 4.02-4.47 4.02" style="stroke:var(--ci-mauve)"/>',
  elm: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M3 1.5h10c.83 0 1.5.67 1.5 1.5v10c0 .83-.67 1.5-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V3c0-.83.67-1.5 1.5-1.5M2 2l12 12M8.5 1.5l6 6M11 11l3.5-3.5m-10-3h6.25M2 14l9-9" style="stroke:var(--ci-blue)"/>',
  env: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M5.5 8.5V12m0-6.5V4m0 4.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3m5 3.5v-1.5m0-3V4m0 6.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3M4 1.5h8A2.5 2.5 0 0 1 14.5 4v8a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.5 12V4A2.5 2.5 0 0 1 4 1.5" style="stroke:var(--ci-yellow)"/>',
  erlang:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-red)"><path d="M6.5 5.5c0-1.25 1-2 2-2s2 .75 2 2z"/><path d="M13.5 13c.47-.57 1.12-1.24 1.5-2l-2.25-1.25c-.74 1.36-1.76 2.75-3.25 2.75c-2.1 0-3-2.3-3-5h8c.05-1.61-.31-3.45-1-4.5M3 13c-1.08-1.3-1.5-3-1.5-5S2.1 4.24 3 3"/></g>',
  eslint:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11.71 1.5L15.42 8l-3.71 6.5H4.29L.58 8l3.71-6.5z" style="stroke:var(--ci-mauve)"/><path d="m8 4.07l3.5 1.97v3.92L8 11.93L4.5 9.96V6.04z" style="stroke:var(--ci-lavender)"/></g>',
  "eslint-ignore":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-overlay)"><path d="M11.71 1.5L15.42 8l-3.71 6.5H4.29L.58 8l3.71-6.5z"/><path d="m8 4.07l3.5 1.97v3.92L8 11.93L4.5 9.96V6.04z"/></g>',
  exe: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-text)"><path d="M3 2.5h10c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V4c0-.83.67-1.5 1.5-1.5m-1.5 3h13"/><path d="m6.5 8l-2 2l2 2m3-4l2 2l-2 2"/></g>',
  favicon:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m3.67 14.57l.83-4.82L1 6.34l4.84-.71L8 1.25l2.16 4.38l4.84.71l-3.5 3.41l.83 4.81L8 12.29z" style="stroke:var(--ci-yellow)"/>',
  file: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M13.5 6.5v6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h4.01m-.01 0l5 5h-4a1 1 0 0 1-1-1z" style="stroke:var(--ci-text)"/>',
  folder:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v6c0 .83-.67 1.5-1.5 1.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/>',
  "folder-api":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.5 13.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3m-3-4a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m6 0a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m0 6a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m-6 0a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m4-4.5L14 9.5M12.5 13l1.5 1.5m-5 0l1.5-1.5M9 9.5l1.5 1.5" style="stroke:var(--ci-yellow)"/></g>',
  "folder-api-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.5 13.5a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3m-3-4a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m6 0a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m0 6a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m-6 0a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m4-4.5L14 9.5M12.5 13l1.5 1.5m-5 0l1.5-1.5M9 9.5l1.5 1.5" style="stroke:var(--ci-yellow)"/></g>',
  "folder-app":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.5 7v1.5m.5 2l2.5 5m-3.5-5l-2.5 5m-.708-4.497a4 4 0 0 0 5.495 2.077" style="stroke:var(--ci-overlay)"/><circle cx="11.5" cy="9.5" r="1" style="stroke:var(--ci-blue)"/></g>',
  "folder-app-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.5 7v1.5m.5 2l2.5 5m-3.5-5l-2.5 5m-.708-4.497a4 4 0 0 0 5.495 2.077" style="stroke:var(--ci-overlay)"/><circle cx="11.5" cy="9.5" r="1" style="stroke:var(--ci-blue)"/></g>',
  "folder-assets":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path fill="none" stroke-linejoin="round" d="M12.923 11.904H7.5L10.212 7Z" style="stroke:var(--ci-yellow)"/><path fill="none" stroke-linejoin="round" d="M11.662 9.641a2.569 2.596 0 1 1-1.308 2.263" style="stroke:var(--ci-yellow)"/>',
  "folder-assets-open":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24L15.12 7M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path fill="none" stroke-linejoin="round" d="M12.923 11.904H7.5L10.21 7Z" style="stroke:var(--ci-yellow)"/><path fill="none" stroke-linejoin="round" d="M11.662 9.641a2.569 2.596 0 1 1-1.308 2.263" style="stroke:var(--ci-yellow)"/>',
  "folder-audio":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><g style="stroke:var(--ci-maroon)"><path d="M10.654 14.423A1.077 1.077 0 0 1 9.577 15.5A1.077 1.077 0 0 1 8.5 14.423a1.077 1.077 0 0 1 1.077-1.077a1.077 1.077 0 0 1 1.077 1.077m4.846-1.077a1.077 1.077 0 0 1-1.077 1.077a1.077 1.077 0 0 1-1.077-1.077a1.077 1.077 0 0 1 1.077-1.077a1.077 1.077 0 0 1 1.077 1.077"/><path d="M10.654 14.423v-4.038c0-.291.237-.652.727-.808L14.773 8.5c.485 0 .727.474.727.808v4.081m-4.846-1.658l4.846-1.616"/></g></g>',
  "folder-audio-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><g style="stroke:var(--ci-maroon)"><path d="M10.654 14.423A1.077 1.077 0 0 1 9.577 15.5A1.077 1.077 0 0 1 8.5 14.423a1.077 1.077 0 0 1 1.077-1.077a1.077 1.077 0 0 1 1.077 1.077m4.846-1.077a1.077 1.077 0 0 1-1.077 1.077a1.077 1.077 0 0 1-1.077-1.077a1.077 1.077 0 0 1 1.077-1.077a1.077 1.077 0 0 1 1.077 1.077"/><path d="M10.654 14.423v-4.038c0-.291.237-.652.727-.808L14.773 8.5c.485 0 .727.474.727.808v4.081m-4.846-1.658l4.846-1.616"/></g></g>',
  "folder-client":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M15.5 15.5h-7m.8-7h5.4a.8.8 0 0 1 .8.8v3.4a.8.8 0 0 1-.8.8H9.3a.8.8 0 0 1-.8-.8V9.3a.8.8 0 0 1 .8-.8" style="stroke:var(--ci-blue)"/></g>',
  "folder-client-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M15.5 15.5h-7m.8-7h5.4a.8.8 0 0 1 .8.8v3.4a.8.8 0 0 1-.8.8H9.3a.8.8 0 0 1-.8-.8V9.3a.8.8 0 0 1 .8-.8" style="stroke:var(--ci-blue)"/></g>',
  "folder-components":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m9.485 9.516l3.968 3.968m-3.968 0l3.968-3.968m-1.634-1.874l3.507 3.507a.496.496 0 0 1 0 .702l-3.507 3.507a.496.496 0 0 1-.701 0L7.61 11.85a.496.496 0 0 1 0-.702l3.507-3.507a.496.496 0 0 1 .701 0z" style="stroke:var(--ci-green)"/></g>',
  "folder-components-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m9.485 9.516l3.968 3.968m-3.968 0l3.968-3.968m-1.634-1.874l3.507 3.507a.496.496 0 0 1 0 .702l-3.507 3.507a.496.496 0 0 1-.701 0L7.61 11.85a.496.496 0 0 1 0-.702l3.507-3.507a.496.496 0 0 1 .701 0z" style="stroke:var(--ci-green)"/></g>',
  "folder-config":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.498 13a1 1 0 1 0 0-2a1 1 0 0 0 0 2m1.752-4L15 12l-1.75 3h-3.5L8 12l1.75-3z" style="stroke:var(--ci-overlay)"/></g>',
  "folder-config-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.498 13a1 1 0 1 0 0-2a1 1 0 0 0 0 2m1.752-4L15 12l-1.75 3h-3.5L8 12l1.75-3z" style="stroke:var(--ci-overlay)"/></g>',
  "folder-core":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M10.5 9.5h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1m0 0v-1m3 1v-1m-3 7v-1m3 1v-1m-5-4h1m-1 3h1m5-3h1m-1 3h1" style="stroke:var(--ci-overlay)"/></g>',
  "folder-core-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M10.5 9.5h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1m0 0v-1m3 1v-1m-3 7v-1m3 1v-1m-5-4h1m-1 3h1m5-3h1m-1 3h1" style="stroke:var(--ci-overlay)"/></g>',
  "folder-coverage":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M12 8L8.5 9.167v2.125c0 2.122 1.195 3.641 3.5 4.208c2.361-.58 3.5-2.087 3.5-4.208V9.167Zm-1.502 3.5l1.504 1.5l1.5-2.5" style="stroke:var(--ci-green)"/></g>',
  "folder-coverage-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M12 8L8.5 9.167v2.125c0 2.122 1.195 3.641 3.5 4.208c2.361-.58 3.5-2.087 3.5-4.208V9.167Zm-1.502 3.5l1.504 1.5l1.5-2.5" style="stroke:var(--ci-green)"/></g>',
  "folder-database":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 9.5q1 1 3.5 1t3.5-1m-7 2.5q1 1 3.5 1t3.5-1m-7 2.5v-5q1-1 3.5-1t3.5 1v5q-1 1-3.5 1t-3.5-1" style="stroke:var(--ci-yellow)"/></g>',
  "folder-database-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 9.5q1 1 3.5 1t3.5-1m-7 2.5q1 1 3.5 1t3.5-1m-7 2.5v-5q1-1 3.5-1t3.5 1v5q-1 1-3.5 1t-3.5-1" style="stroke:var(--ci-yellow)"/></g>',
  "folder-dist":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M9.5 10.5h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1m1-2h3v2h-3z" style="stroke:var(--ci-red)"/></g>',
  "folder-dist-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M9.5 10.5h5a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1m1-2h3v2h-3z" style="stroke:var(--ci-red)"/></g>',
  "folder-docker":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><g style="stroke:var(--ci-blue)"><path d="M8.5 11.5h5l.25-.5c-.151-.555-.465-.945-.25-1.5c.47.297.65.937 1 1c.357-.044 1-1 1 0c0 0 0 1.5-1 1.5c-.5 2-1.75 2.5-3.5 2.5c-2.75 0-2.5-3-2.5-3"/><path d="M9.5 11.5v-2h2v2"/></g></g>',
  "folder-docker-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><g style="stroke:var(--ci-blue)"><path d="M8.5 11.5h5l.25-.5c-.151-.555-.465-.945-.25-1.5c.47.297.65.937 1 1c.357-.044 1-1 1 0c0 0 0 1.5-1 1.5c-.5 2-1.75 2.5-3.5 2.5c-2.75 0-2.5-3-2.5-3" transform="matrix(.99904 0 0 1 .008 0)"/><path d="M9.5 11.5v-2h2v2" transform="matrix(.99904 0 0 1 .008 0)"/></g></g>',
  "folder-docs":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 14.5v-5a1 1 0 0 1 1-1h6v6m-6-1h6v2h-6a1 1 0 1 1 0-2" style="stroke:var(--ci-blue)"/></g>',
  "folder-docs-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 14.5v-5a1 1 0 0 1 1-1h6v6m-6-1h6v2h-6a1 1 0 1 1 0-2" style="stroke:var(--ci-blue)"/></g>',
  "folder-download":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M9.5 15.5h4m-2-7v5m-2-2l2 2l2-2" style="stroke:var(--ci-sky)"/></g>',
  "folder-download-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M9.5 15.5h4m-2-7v5m-2-2l2 2l2-2" style="stroke:var(--ci-sky)"/></g>',
  "folder-examples":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.5 7.5c-1.682 0-3 1.259-3 2.806c0 1.165.623 1.72 1.115 2.126c.316.261.887.418.887.612v.424c-.006.248-.004.505-.004.756c0 .763.332 1.276 1.012 1.276s.992-.513.992-1.276c0-.25.001-.517-.004-.756v-.424c0-.295.596-.473.957-.763c.488-.393 1.045-.88 1.045-1.975c0-1.547-1.318-2.806-3-2.806m-.998 5.956h1.996" style="stroke:var(--ci-yellow)"/></g>',
  "folder-examples-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.5 7.5c-1.682 0-3 1.259-3 2.806c0 1.165.623 1.72 1.115 2.126c.316.261.887.418.887.612v.424c-.006.248-.004.505-.004.756c0 .763.332 1.276 1.012 1.276s.992-.513.992-1.276c0-.25.001-.517-.004-.756v-.424c0-.295.596-.473.957-.763c.488-.393 1.045-.88 1.045-1.975c0-1.547-1.318-2.806-3-2.806m-.998 5.956h1.996" style="stroke:var(--ci-yellow)"/></g>',
  "folder-fonts":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M9.163 15.477L11.999 8.5l2.837 6.977M8.5 15.5h1.477m4.046 0H15.5m-5.5-2h4" style="stroke:var(--ci-flamingo)"/></g>',
  "folder-fonts-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M9.163 15.477L11.999 8.5l2.837 6.977M8.5 15.5h1.477m4.046 0H15.5m-5.5-2h4" style="stroke:var(--ci-flamingo)"/></g>',
  "folder-git":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M10.5 10.5v3m-.75-4.75L8 7m4.75 4.75l-1.5-1.5m-.75 5.25a1 1 0 1 0 0-2a1 1 0 0 0 0 2m0-5a1 1 0 1 0 0-2a1 1 0 0 0 0 2m3 3a1 1 0 1 0 0-2a1 1 0 0 0 0 2" style="stroke:var(--ci-peach)"/></g>',
  "folder-git-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M10.5 10.5v3m-.75-4.75L8 7m4.75 4.75l-1.5-1.5m-.75 5.25a1 1 0 1 0 0-2a1 1 0 0 0 0 2m0-5a1 1 0 1 0 0-2a1 1 0 0 0 0 2m3 3a1 1 0 1 0 0-2a1 1 0 0 0 0 2" style="stroke:var(--ci-peach)"/></g>',
  "folder-github":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M10 14.907c-1.5.5-1.25-.657-2-.907m5 1.5v-1.062c0-.447-.238-.67-.5-.938c1.225-.134 2.5-.58 2.5-2.633c0-.534-.205-.965-.569-1.348a1.9 1.9 0 0 0-.043-1.428s-.482-.134-1.532.58a5.3 5.3 0 0 0-2.712 0c-1.05-.714-1.531-.58-1.531-.58a1.9 1.9 0 0 0-.044 1.428c-.364.383-.568.814-.569 1.348c0 2.053 1.275 2.5 2.5 2.633c-.262.268-.544.58-.5.938V15.5" style="stroke:var(--ci-overlay)"/></g>',
  "folder-github-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M10 14.907c-1.5.5-1.25-.657-2-.907m5 1.5v-1.062c0-.447-.238-.67-.5-.938c1.225-.134 2.5-.58 2.5-2.633c0-.534-.205-.965-.569-1.348a1.9 1.9 0 0 0-.043-1.428s-.482-.134-1.532.58a5.3 5.3 0 0 0-2.712 0c-1.05-.714-1.531-.58-1.531-.58a1.9 1.9 0 0 0-.044 1.428c-.364.383-.568.814-.569 1.348c0 2.053 1.275 2.5 2.5 2.633c-.262.268-.544.58-.5.938V15.5" style="stroke:var(--ci-overlay)"/></g>',
  "folder-gitlab":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path stroke-linecap="square" d="m12 15.5l3.5-2.515l-1-4.485l-1.5 2h-2l-1.5-2l-1 4.485z" style="stroke:var(--ci-peach)"/></g>',
  "folder-gitlab-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path stroke-linecap="square" d="m12 15.5l3.5-2.515l-1-4.485l-1.5 2h-2l-1.5-2l-1 4.485z" style="stroke:var(--ci-peach)"/></g>',
  "folder-hooks":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M12.5 9.5c0 1.333 2 1.333 2 0s-2-1.333-2 0m1 1v2.668c-.003 3.109-4.003 3.109-4 0V11.5L11 13" style="stroke:var(--ci-mauve)"/></g>',
  "folder-hooks-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M12.5 9.5c0 1.333 2 1.333 2 0s-2-1.333-2 0m1 1v2.668c-.003 3.109-4.003 3.109-4 0V11.5L11 13" style="stroke:var(--ci-mauve)"/></g>',
  "folder-husky":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m9.06 12.284l2.118-.774c.65-.238 1.36.163 1.474.831l.372 2.18c.12.702-.65 1.224-1.28.868a.6.6 0 0 1-.207-.19l-.11-.162A2.63 2.63 0 0 0 9.4 13.893l-.198-.011a.6.6 0 0 1-.271-.08a.834.834 0 0 1 .128-1.518" style="stroke:var(--ci-rosewater)"/><path d="M9.224 10.801c.398.23.944.036 1.22-.435c.276-.47.176-1.039-.222-1.27c-.398-.23-.944-.035-1.22.436c-.275.47-.176 1.04.222 1.27m2.62-1c.398.23.944.036 1.22-.435c.275-.47.176-1.039-.222-1.27c-.398-.23-.944-.035-1.22.436c-.275.47-.176 1.04.222 1.27m2.045 1c.398.23.944.036 1.22-.435c.276-.47.177-1.039-.221-1.27c-.398-.23-.944-.035-1.22.436c-.276.47-.177 1.04.221 1.27m.688 2.793c.398.23.945.035 1.22-.436c.276-.47.177-1.039-.22-1.269c-.399-.23-.945-.035-1.22.435c-.277.471-.178 1.04.22 1.27" style="fill:var(--ci-rosewater)"/></g>',
  "folder-husky-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m9.06 12.285l2.118-.775c.65-.238 1.36.163 1.474.831l.372 2.18c.12.702-.65 1.224-1.28.868a.6.6 0 0 1-.207-.19l-.11-.162A2.63 2.63 0 0 0 9.4 13.893l-.198-.011a.6.6 0 0 1-.271-.08a.834.834 0 0 1 .128-1.517" style="stroke:var(--ci-rosewater)"/><path d="M9.224 10.801c.398.23.944.036 1.22-.435c.276-.47.176-1.039-.222-1.27c-.398-.23-.944-.035-1.22.436c-.275.47-.176 1.04.222 1.27m2.62-1c.398.23.944.036 1.22-.435c.275-.47.176-1.039-.222-1.27c-.398-.23-.944-.035-1.22.436c-.275.47-.176 1.04.222 1.27m2.045 1c.398.23.944.036 1.22-.435c.276-.47.177-1.039-.221-1.27c-.398-.23-.944-.035-1.22.436c-.276.47-.177 1.04.221 1.27m.688 2.793c.398.23.945.035 1.22-.436c.276-.47.177-1.039-.22-1.269c-.399-.23-.945-.035-1.22.435c-.277.471-.178 1.04.22 1.27" style="fill:var(--ci-rosewater)"/></g>',
  "folder-images":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M14.5 15.5L11 12l-2.5 2.5" style="stroke:var(--ci-green)"/><path d="M9.5 8.5h4.997a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H9.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1" style="stroke:var(--ci-sapphire)"/><circle cx="13.5" cy="10.5" r=".5" style="stroke:var(--ci-yellow)"/></g>',
  "folder-images-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M14.5 15.5L11 12l-2.5 2.5" style="stroke:var(--ci-green)"/><path d="M9.5 8.5h4.997a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H9.5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1" style="stroke:var(--ci-sapphire)"/><circle cx="13.5" cy="10.5" r=".5" style="stroke:var(--ci-yellow)"/></g>',
  "folder-include":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><circle cx="11.623" cy="11.623" r="3.877" fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-sapphire)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M11.634 9.708v3.838m1.919-1.92H9.715" style="stroke:var(--ci-sapphire)"/>',
  "folder-include-open":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><circle cx="11.623" cy="11.623" r="3.877" fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-sapphire)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M11.634 9.708v3.838m1.919-1.92H9.715" style="stroke:var(--ci-sapphire)"/>',
  "folder-kubernetes":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><g style="stroke:var(--ci-blue)"><circle cx="11.494" cy="11.509" r="2.992"/><path d="M11.494 11.51V7.47m0 4.04L9.389 9.83l-1.053-.84m3.158 2.52l1.168 2.425l.584 1.214m-1.752-3.64l2.625.6l1.312.3m-3.937-.9l2.105-1.679l1.052-.84m-3.157 2.52l-2.625.598l-1.313.3m3.938-.899l-1.169 2.426l-.584 1.213"/></g></g>',
  "folder-kubernetes-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><g style="stroke:var(--ci-blue)"><circle cx="11.494" cy="11.509" r="2.992"/><path d="M11.494 11.51V7.47m0 4.04L9.389 9.83l-1.053-.84m3.158 2.52l1.168 2.425l.584 1.214m-1.752-3.64l2.625.6l1.312.3m-3.937-.9l2.105-1.679l1.052-.84m-3.157 2.52l-2.625.598l-1.313.3m3.938-.899l-1.169 2.426l-.584 1.213"/></g></g>',
  "folder-layouts":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M9 8.5h6a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H9a.5.5 0 0 1-.5-.5V9a.5.5 0 0 1 .5-.5m-.5 2h7m-5 .5v4" style="stroke:var(--ci-blue)"/></g>',
  "folder-layouts-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M9 8.5h6a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-.5.5H9a.5.5 0 0 1-.5-.5V9a.5.5 0 0 1 .5-.5m-.5 2h7m-5 .5v4" style="stroke:var(--ci-blue)"/></g>',
  "folder-lib":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M8.259 7.856h1.17a.585.585 0 0 1 .585.585v6.43a.585.585 0 0 1-.585.585H8.26a.585.585 0 0 1-.586-.585v-6.43a.585.585 0 0 1 .586-.585M10.6 9.61h.586a.585.585 0 0 1 .585.585v4.676a.585.585 0 0 1-.585.585H10.6a.585.585 0 0 1-.586-.585v-4.676a.585.585 0 0 1 .586-.585m2.036.234l1.13-.304a.293.292 0 0 1 .363.204l1.363 5.087a.293.292 0 0 1-.21.35l-1.13.31a.293.292 0 0 1-.357-.21l-1.364-5.086a.293.292 0 0 1 .205-.351" style="stroke:var(--ci-overlay)"/>',
  "folder-lib-open":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M8.259 7.856h1.17a.585.585 0 0 1 .586.585v6.43a.585.585 0 0 1-.586.585H8.26a.585.585 0 0 1-.586-.584V8.44a.585.585 0 0 1 .586-.585m2.34 1.754h.586a.585.585 0 0 1 .585.585v4.677a.585.585 0 0 1-.585.584H10.6a.585.585 0 0 1-.585-.584v-4.677a.585.585 0 0 1 .585-.585m2.036.234l1.13-.304a.293.292 0 0 1 .363.205l1.364 5.086a.293.292 0 0 1-.211.35l-1.13.31a.293.292 0 0 1-.357-.21l-1.363-5.086a.293.292 0 0 1 .204-.351" style="stroke:var(--ci-overlay)"/>',
  "folder-locales":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M12 14.5h3m-3.5 1l2-4l2 4m-6-4s.556 1.734 3 2m-1-3.5s.148 3.3-3 3.5H8m0-4h5M10.5 8v1.5" style="stroke:var(--ci-mauve)"/></g>',
  "folder-locales-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M12 14.5h3m-3.5 1l2-4l2 4m-6-4s.556 1.734 3 2m-1-3.5s.148 3.3-3 3.5H8m0-4h5M10.5 8v1.5" style="stroke:var(--ci-mauve)"/></g>',
  "folder-middleware":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M15.5 13.5v1.2a.8.8 0 0 1-.8.8h-4.4a.8.8 0 0 1-.8-.8v-1.2H9a1 1 0 0 1 0-2h.5v-1.2a.8.8 0 0 1 .8-.8h1.2V9a1 1 0 0 1 2 0v.5h1.2a.8.8 0 0 1 .8.8v1.2H15a1 1 0 0 0 0 2z" style="stroke:var(--ci-green)"/></g>',
  "folder-middleware-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M15.5 13.5v1.2a.8.8 0 0 1-.8.8h-4.4a.8.8 0 0 1-.8-.8v-1.2H9a1 1 0 0 1 0-2h.5v-1.2a.8.8 0 0 1 .8-.8h1.2V9a1 1 0 0 1 2 0v.5h1.2a.8.8 0 0 1 .8.8v1.2H15a1 1 0 0 0 0 2z" style="stroke:var(--ci-green)"/></g>',
  "folder-mocks":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m10.327 15.5l4.795-4.795a1.292 1.292 0 1 0-1.827-1.827L8.5 13.673V15.5zm2.511-6.165l1.827 1.827" style="stroke:var(--ci-sky)"/></g>',
  "folder-mocks-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m10.327 15.5l4.795-4.795a1.292 1.292 0 1 0-1.827-1.827L8.5 13.673V15.5zm2.511-6.165l1.827 1.827" style="stroke:var(--ci-sky)"/></g>',
  "folder-node":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m12.5 8.576l3 1.714v3.42l-3 1.714l-3-1.714v-3.42z" style="stroke:var(--ci-green)"/></g>',
  "folder-node-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m12.5 8.576l3 1.714v3.42l-3 1.714l-3-1.714v-3.42z" style="stroke:var(--ci-green)"/></g>',
  "folder-open":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-1.75 7a1 1 0 0 1-.97.76H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/>',
  "folder-packages":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M12 15.337v-3.919L8.5 9.214m3.5 2.204l3.5-2.204M12 7.5l3.5 1.714v4.408L12 15.5l-3.5-1.878V9.214Z" style="stroke:var(--ci-peach)"/></g>',
  "folder-packages-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M12 15.337v-3.919L8.5 9.214m3.5 2.204l3.5-2.204M12 7.5l3.5 1.714v4.408L12 15.5l-3.5-1.878V9.214Z" style="stroke:var(--ci-peach)"/></g>',
  "folder-plugins":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m8.518 15.5l1.015-1.016m3.969-5.968l-2 1.99m3.998.01l-1.998 2m-2.97-2.625l3.595 3.594l-.899.898a2.542 2.542 0 1 1-3.594-3.594Z" style="stroke:var(--ci-blue)"/></g>',
  "folder-plugins-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m8.518 15.5l1.015-1.016m3.969-5.968l-2 1.99m3.998.01l-1.998 2m-2.97-2.625l3.595 3.594l-.899.898c-.57.629-1.545.914-2.477.704c-.899-.202-1.589-.928-1.82-1.82a2.54 2.54 0 0 1 .703-2.478Z" style="stroke:var(--ci-blue)"/></g>',
  "folder-private":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><circle cx="11.623" cy="11.623" r="3.877" fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-red)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m14.347 8.935l-5.432 5.432" style="stroke:var(--ci-red)"/>',
  "folder-private-open":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><circle cx="11.623" cy="11.623" r="3.877" fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-red)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m14.347 8.935l-5.432 5.432" style="stroke:var(--ci-red)"/>',
  "folder-public":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 12h7M12 15.5c-1.933 0-3.5-1.5-3.5-3.5s1.567-3.5 3.5-3.5c2 0 3.5 1.5 3.5 3.5S14 15.5 12 15.5M11.556 9c-1.379 2.01-1.448 4.01.087 6.34M12.454 9c1.361 1.98 1.45 3.98-.062 6.34" style="stroke:var(--ci-sapphire)"/></g>',
  "folder-public-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 12h7M12 15.5c-1.933 0-3.5-1.5-3.5-3.5s1.567-3.5 3.5-3.5c2 0 3.5 1.5 3.5 3.5S14 15.5 12 15.5M11.556 9c-1.38 2.01-1.448 4.01.087 6.34M12.454 9c1.36 1.98 1.45 3.98-.062 6.34" style="stroke:var(--ci-sapphire)"/></g>',
  "folder-routes":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.5 11.5v4m0-7.5v1.5m-1.5 6h3m-4.5-6v2h5.75l1.25-1l-1.25-1z" style="stroke:var(--ci-green)"/></g>',
  "folder-routes-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.5 11.5v4m0-7.5v1.5m-1.5 6h3m-4.5-6v2h5.75l1.25-1l-1.25-1z" style="stroke:var(--ci-green)"/></g>',
  "folder-scripts":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 13.5V9.75C8.5 9 9 8.5 9.75 8.5h3.75v5.75c0 .75-.5 1.25-1.25 1.25H8.5a1 1 0 0 1 0-2h3a1 1 0 0 0 0 2m2-5h1a1 1 0 0 0 0-2h-1" style="stroke:var(--ci-mauve)"/></g>',
  "folder-scripts-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 13.5V9.75C8.5 9 9 8.5 9.75 8.5h3.75v5.75c0 .75-.5 1.25-1.25 1.25H8.5a1 1 0 0 1 0-2h3a1 1 0 0 0 0 2m2-5h1a1 1 0 0 0 0-2h-1" style="stroke:var(--ci-mauve)"/></g>',
  "folder-server":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 9.5h7v2h-7zm2 0v2m-2 2h7v2h-7zm2 0v2" style="stroke:var(--ci-yellow)"/></g>',
  "folder-server-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 9.5h7v2h-7zm2 0v2m-2 2h7v2h-7zm2 0v2" style="stroke:var(--ci-yellow)"/></g>',
  "folder-shared":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12c.83 0 1.5.67 1.5 1.5v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m11.805 7.442l3.695 3.72l-3.695 3.512V12.4c-2.873 0-4.105 3.1-4.105 3.1c0-3.513 1.027-5.786 4.105-5.786z" style="stroke:var(--ci-pink)"/>',
  "folder-shared-open":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m1.87 8l.7-2.74a1 1 0 0 1 .96-.76h10.94a1 1 0 0 1 .97 1.24l-.219.875M6 13.5H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m11.805 7.442l3.695 3.72l-3.695 3.512V12.4c-2.873 0-4.105 3.1-4.105 3.1c0-3.513 1.027-5.786 4.105-5.786z" style="stroke:var(--ci-pink)"/>',
  "folder-src":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m10.5 8.5l-3 3.5l3 3.5m2-7l3 3.5l-3 3.5" style="stroke:var(--ci-green)"/></g>',
  "folder-src-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m10.5 8.5l-3 3.5l3 3.5m2-7l3 3.5l-3 3.5" style="stroke:var(--ci-green)"/></g>',
  "folder-styles":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 15.5v-1.555a1.556 1.556 0 1 1 1.556 1.555zm7-7a6.22 6.22 0 0 0-4.978 3.967M15.5 8.5a6.22 6.22 0 0 1-3.967 4.978m-.077-2.645a3.5 3.5 0 0 1 1.71 1.711" style="stroke:var(--ci-blue)"/></g>',
  "folder-styles-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M8.5 15.5v-1.555a1.556 1.556 0 1 1 1.556 1.555zm7-7a6.22 6.22 0 0 0-4.978 3.967M15.5 8.5a6.22 6.22 0 0 1-3.967 4.978m-.077-2.645a3.5 3.5 0 0 1 1.71 1.711" style="stroke:var(--ci-blue)"/></g>',
  "folder-temp":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M12 15.5a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7m0-5.5v2h1" style="stroke:var(--ci-teal)"/></g>',
  "folder-temp-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M12 15.5a3.5 3.5 0 1 0 0-7a3.5 3.5 0 0 0 0 7m0-5.5v2h1" style="stroke:var(--ci-teal)"/></g>',
  "folder-templates":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.5 10.5h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1m2-.333v-.834a.833.833 0 0 0-.833-.833H9.333a.833.833 0 0 0-.833.833v3.334c0 .46.373.833.833.833h.834" style="stroke:var(--ci-maroon)"/></g>',
  "folder-templates-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M11.5 10.5h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1m2-.333v-.834a.833.833 0 0 0-.833-.833H9.333a.833.833 0 0 0-.833.833v3.334c0 .46.373.833.833.833h.834" style="stroke:var(--ci-maroon)"/></g>',
  "folder-tests":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m13.158 9.16l-4.272 4.254c-.558.555-.45 1.31-.064 1.694c.406.403 1.077.64 1.743-.023l4.269-4.25M12.5 8.501l.5.5l1 1l1 1l.5.5m-3.478 2.005H8.96" style="stroke:var(--ci-teal)"/></g>',
  "folder-tests-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m13.158 9.16l-4.272 4.253c-.558.555-.45 1.31-.064 1.694c.406.404 1.077.641 1.743-.022l4.269-4.25M12.5 8.5l.5.5l1 1l1 1l.5.5m-3.478 2.006H8.96" style="stroke:var(--ci-teal)"/></g>',
  "folder-themes":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.4"><path d="M12 21a9 9 0 0 1 0-18c4.97 0 9 3.582 9 8c0 1.06-.474 2.078-1.318 2.828S17.693 15 16.5 15H14a2 2 0 0 0-1 3.75A1.3 1.3 0 0 1 12 21" transform="matrix(.41667 0 0 .4167 6.75 6.747)" style="stroke:var(--ci-rosewater)"/><path d="M7.5 10.5c0 1.333 2 1.333 2 0s-2-1.333-2 0" transform="matrix(.41667 0 0 .4167 6.75 6.747)" style="stroke:var(--ci-red)"/><path d="M11.5 7.5c0 1.333 2 1.333 2 0s-2-1.333-2 0" transform="matrix(.41667 0 0 .4167 6.75 6.747)" style="stroke:var(--ci-green)"/><path d="M15.5 10.5c0 1.333 2 1.333 2 0s-2-1.333-2 0" transform="matrix(.41667 0 0 .4167 6.75 6.747)" style="stroke:var(--ci-blue)"/></g>',
  "folder-themes-open":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="2.4"><path d="M12 21a9 9 0 0 1 0-18c4.97 0 9 3.582 9 8c0 1.06-.474 2.078-1.318 2.828S17.693 15 16.5 15H14a2 2 0 0 0-1 3.75A1.3 1.3 0 0 1 12 21" transform="matrix(.41667 0 0 .4167 6.75 6.747)" style="stroke:var(--ci-rosewater)"/><path d="M7.5 10.5c0 1.333 2 1.333 2 0s-2-1.333-2 0" transform="matrix(.41667 0 0 .4167 6.75 6.747)" style="stroke:var(--ci-red)"/><path d="M11.5 7.5c0 1.333 2 1.333 2 0s-2-1.333-2 0" transform="matrix(.41667 0 0 .4167 6.75 6.747)" style="stroke:var(--ci-green)"/><path d="M15.5 10.5c0 1.333 2 1.333 2 0s-2-1.333-2 0" transform="matrix(.41667 0 0 .4167 6.75 6.747)" style="stroke:var(--ci-blue)"/></g>',
  "folder-types":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m8.499 12.5l4.001-4h3v3l-4 4.003z" style="stroke:var(--ci-teal)"/></g>',
  "folder-types-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m8.499 12.5l4.001-4h3v3l-4 4.003z" style="stroke:var(--ci-teal)"/></g>',
  "folder-utils":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m15.5 14l-1.265-1.266a3 3 0 0 0-3.969-3.97L12 10.5L10.5 12l-1.736-1.733a3 3 0 0 0 3.97 3.968L14 15.5" style="stroke:var(--ci-green)"/></g>',
  "folder-utils-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m15.5 14l-1.265-1.266a3 3 0 0 0-3.969-3.97L12 10.5L10.5 12l-1.736-1.733a3 3 0 0 0 3.97 3.968L14 15.5" style="stroke:var(--ci-green)"/></g>',
  "folder-video":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m15.5 12l-5-3.5v7zm-7-3.5v7" style="stroke:var(--ci-blue)"/></g>',
  "folder-video-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m15.5 12l-5-3.5v7zm-7-3.5v7" style="stroke:var(--ci-blue)"/></g>',
  "folder-views":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M14.692 8.5H9.308a.31.31 0 0 0-.307.336l.47 5.241c.01.128.1.235.223.27l2.303 1.153l2.308-1.153a.31.31 0 0 0 .225-.27L15 8.836a.31.31 0 0 0-.307-.336" style="stroke:var(--ci-peach)"/></g>',
  "folder-views-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M14.692 8.5H9.308a.31.31 0 0 0-.307.336l.47 5.241c.01.128.1.235.223.27l2.303 1.153l2.308-1.153a.31.31 0 0 0 .225-.27L15 8.836a.31.31 0 0 0-.307-.336" style="stroke:var(--ci-peach)"/></g>',
  "folder-vscode":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m8 10l5.555 5.432s.179.143.342.015l1.434-.739c.195-.144.168-.321.168-.321V9.55c0-.212-.202-.286-.202-.286l-1.322-.687c-.288-.192-.477.035-.477.035l-.421.406L8 14" style="stroke:var(--ci-blue)"/></g>',
  "folder-vscode-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="m8 10l5.555 5.432s.179.143.342.015l1.434-.739c.195-.144.168-.321.168-.321V9.55c0-.212-.202-.286-.202-.286l-1.322-.687c-.288-.192-.477.035-.477.035l-.421.406L8 14" style="stroke:var(--ci-blue)"/></g>',
  "folder-workflows":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5H12A1.5 1.5 0 0 1 13.5 6v.5m-7.5 7H2A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M9.5 8.5h1a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1m4 4h1a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1m-4-1v3h3" style="stroke:var(--ci-peach)"/></g>',
  "folder-workflows-open":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m1.875 8l.686-2.743a1 1 0 0 1 .97-.757h10.938a1 1 0 0 1 .97 1.243l-.315 1.26M6 13.5H2.004A1.5 1.5 0 0 1 .5 12V3.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" style="stroke:var(--ci-text)"/><path d="M9.5 8.5h1a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1m4 4h1a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1a1 1 0 0 1 1-1m-4-1v3h3" style="stroke:var(--ci-peach)"/></g>',
  font: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m7 5l4 8.5h2.5L8 2.5l-4.5 11m-1 0h2m5 0h5m-9-4H9" style="stroke:var(--ci-flamingo)"/>',
  git: '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 10.5a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m0-6a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m3 3a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m-4-2v4m-1-6l-1-1m4 4l-1-1" style="stroke:var(--ci-text)"/><path d="m9.06 1.06l5.88 5.88a1.5 1.5 0 0 1 0 2.12l-5.88 5.88a1.5 1.5 0 0 1-2.12 0L1.06 9.06a1.5 1.5 0 0 1 0-2.12l5.88-5.88a1.5 1.5 0 0 1 2.12 0" style="stroke:var(--ci-peach)"/></g>',
  gitlab:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M8 14.49L14.5 10L12 2l-1.5 4.5h-5L4 2l-2.5 8z" style="stroke:var(--ci-peach)"/>',
  go: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m15.48 8.06l-4.85.48m4.85-.48a4.98 4.98 0 0 1-4.54 5.42a5 5 0 1 1 2.95-8.66l-1.7 1.84a2.5 2.5 0 0 0-4.18 2.06c.05.57.3 1.1.69 1.51c.25.27 1 .83 1.78.82c.8-.02 1.58-.25 2.07-.81c0 0 .8-.96.68-1.88M2.5 8.5l-2 .01m1.5 2h1.5m-2-3.99l2-.02" style="stroke:var(--ci-sapphire)"/>',
  "go-mod":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m2.5 8.51l-2 .01m1.5 2h1.5m-2-4h1m6.73-2.19a1.5 1.5 0 1 0-2.16.58m2.16-.58l2.78-.74l.75 2.78m.57 2.16l.75 2.79l-7.73 2.07l-2.07-7.73l2.78-.75m6.28 3.63a1.5 1.5 0 1 0-.58-2.17" style="stroke:var(--ci-sapphire)"/>',
  gradle:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-sapphire)"><path d="m7.5 7.5l-1.97.78c-.2.15-.74.33-1.2-.2a7.3 7.3 0 0 1-1-1.63"/><path d="M11.43 2.98c.54-.48 4.07-1.39 4.07 2.1c0 2.34-1.6 3.53-2.76 4.5c-.75.61-1.35 1.28-1.35 3.92H9.88c0-1.29-2.66-2.32-3.17 0H5.38c0-1.29-2.65-2.32-3.16 0H.7C.29 11.92.22 8.3 3.33 6.45c-.15-.25-.27-1.02.43-1.3c.87-.34 3.77-1.34 6.51.12s5.01 1.12 5.14.74"/></g>',
  graphql:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M9 1.5a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m-5.5 3a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m0 7a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m11 0a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m-5.5 3a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m5.5-10a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m-12 1v5m11-5v5m-10 1h9m-6 2.5l-3-1.5m6 1.5l3-1.5m-9-2l4-8m5 8l-4-8m-5 1l3-1.5m3 0l3 1.5" style="stroke:var(--ci-pink)"/>',
  groovy:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-sapphire)"><path d="M11.68 5.38c.4.19.54.68 1.53 3.25c1 2.57-.92 4.07-.92 4.07s-6.73 2.47-6.73 1.63c-.18-.92-1.92-2.08-1.92-2.08s-.52-.63.06-.75c5.89-1.27 6.96-.61 7.3-2"/><path d="M7.38 10.63C2.62 10.88 2.48 8.08 2.5 8C3.6 4.6 9.24.91 10.8 1.58C14.07 3.04 9.2 8.96 7 8.5c-4.02-.83 1.5-4 1.5-4"/></g>',
  haskell:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M12.5 4.5h3m-1.5 3h1.5m-10 6l2.5-5l-2.5-5H8l5.6 10h-2.53l-1.52-2.92L8 13.5zm-5 0l2.5-5l-2.5-5H3l2.5 5l-2.5 5z" style="stroke:var(--ci-mauve)"/>',
  html: '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 1.5h13L13 13l-5 2l-5-2z" style="stroke:var(--ci-peach)"/><path d="M11 4.5H5l.25 3h5.5l-.25 3l-2.5 1l-2.5-1l-.08-1" style="stroke:var(--ci-text)"/></g>',
  http: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-blue)"><path d="M14.5 8A6.5 6.5 0 0 1 8 14.5A6.5 6.5 0 0 1 1.5 8A6.5 6.5 0 0 1 8 1.5A6.5 6.5 0 0 1 14.5 8"/><path d="M8 1.5c1.67 2 2.5 4.17 2.5 6.5s-.83 4.5-2.5 6.5m0-13A9.96 9.96 0 0 0 5.5 8c0 2.33.83 4.5 2.5 6.5m-5.5-4h11m-11-5h11"/></g>',
  image:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 6A1.5 1.5 0 0 1 10 7.5A1.5 1.5 0 0 1 8.5 6A1.5 1.5 0 0 1 10 4.5A1.5 1.5 0 0 1 11.5 6" style="stroke:var(--ci-yellow)"/><path d="M7.5 13.5L11 10c.5-.5 1.5-.5 2 0l1.5 1.5" style="stroke:var(--ci-green)"/><path d="m1.5 9.5l2-2C4 7 5 7 5.5 7.5l4 4" style="stroke:var(--ci-green)"/><path d="M3 2.5h10c.83 0 1.5.67 1.5 1.5v8c0 .83-.67 1.5-1.5 1.5H3A1.5 1.5 0 0 1 1.5 12V4c0-.83.67-1.5 1.5-1.5" style="stroke:var(--ci-sapphire)"/></g>',
  java: '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.73 8.41c.57 3 1.59 5.83 2.77 7.09c-6.63-3.45-9.76-1.75-10.5 0c-.66-3.4-.54-5.74.09-7.78" style="stroke:var(--ci-text)"/><path d="M8.5 7c.63.34 1.82 1.07 2.24 1.41c-.54-2.9-.64-5.96-.74-7.91c-2.13.58-5.73 1.98-6.9 7.22c.52-.69 1.72-1.05 2.4-1.22" style="stroke:var(--ci-red)"/><path d="M5.5 7A1.5 1.5 0 0 0 7 8.5A1.5 1.5 0 0 0 8.5 7A1.5 1.5 0 0 0 7 5.5A1.5 1.5 0 0 0 5.5 7" style="stroke:var(--ci-red)"/></g>',
  "java-class":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M13.825 10.605V5.393a1.282 1.287 0 0 0-.647-1.116l-4.53-2.605a1.307 1.313 0 0 0-1.295 0L2.822 4.277c-.4.23-.647.657-.647 1.117v5.212c0 .46.246.886.647 1.116l4.53 2.605a1.307 1.313 0 0 0 1.295 0l4.531-2.605c.4-.231.647-.657.647-1.117M8 14.5V8m0 0l5.65-3.276m-11.3 0L8 8" style="stroke:var(--ci-blue)"/>',
  "java-jar":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.73 8.41c.57 3 1.59 5.83 2.77 7.09c-6.63-3.45-9.76-1.75-10.5 0c-.66-3.4-.54-5.74.09-7.78" style="stroke:var(--ci-text)"/><path d="M8.5 7c.63.34 1.82 1.07 2.24 1.41c-.54-2.9-.64-5.96-.74-7.91c-2.13.58-5.73 1.98-6.9 7.22c.52-.69 1.72-1.05 2.4-1.22" style="stroke:var(--ci-overlay)"/><path d="M5.5 7A1.5 1.5 0 0 0 7 8.5A1.5 1.5 0 0 0 8.5 7A1.5 1.5 0 0 0 7 5.5A1.5 1.5 0 0 0 5.5 7" style="stroke:var(--ci-overlay)"/></g>',
  javascript:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-yellow)"><path d="M4.5 11a1.5 1.5 0 0 0 3 0V7.5m5 1.25c0-.69-.537-1.25-1.2-1.25h-.6c-.663 0-1.2.56-1.2 1.25S10.037 10 10.7 10h.6c.663 0 1.2.56 1.2 1.25s-.537 1.25-1.2 1.25h-.6c-.663 0-1.2-.56-1.2-1.25"/><path d="M4 1.5h8c1.385 0 2.5 1.115 2.5 2.5v8c0 1.385-1.115 2.5-2.5 2.5H4A2.495 2.495 0 0 1 1.5 12V4c0-1.385 1.115-2.5 2.5-2.5"/></g>',
  "javascript-config":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 5c-.33-.33-.83-.5-1.5-.5c-1 0-1.5.5-1.5 1s.5 1 1.5 1s1.5.5 1.5 1s-.5 1-1.5 1c-.67 0-1.17-.17-1.5-.5m-2-3.5v3a1 1 0 1 1-2 0" style="stroke:var(--ci-yellow)"/><path d="M6.5 11.5h-4a2 2 0 0 1-2-2v-7c0-1.1.9-2 2-2h7a2 2 0 0 1 2 2V7" style="stroke:var(--ci-yellow)"/><path d="M11.5 13.5a1 1 0 1 0 0-2a1 1 0 0 0 0 2m1.75-4l1.75 3l-1.75 3h-3.5L8 12.5l1.75-3z" style="stroke:var(--ci-overlay)"/></g>',
  "javascript-map":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M.5 4.06c0 .77.24 1.52.7 2.13l2.24 3.96l.04.08h0c.13.17.32.27.52.27s.36-.09.48-.23h0l.03-.03l.08-.15l2.2-3.88c.46-.61.71-1.37.71-2.15A3.63 3.63 0 0 0 3.88.5C1.95.5.5 2.1.5 4.06" style="stroke:var(--ci-red)"/><path d="M5.5 4A1.5 1.5 0 0 1 4 5.5A1.5 1.5 0 0 1 2.5 4A1.5 1.5 0 0 1 4 2.5A1.5 1.5 0 0 1 5.5 4" style="stroke:var(--ci-red)"/><path d="M10 4.5h3.5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V13" style="stroke:var(--ci-yellow)"/><path d="M13.5 9c-.33-.33-.83-.5-1.5-.5c-1 0-1.5.5-1.5 1s.5 1 1.5 1s1.5.5 1.5 1s-.5 1-1.5 1c-.67 0-1.17-.17-1.5-.5m-2-3.5v3a1 1 0 1 1-2 0" style="stroke:var(--ci-yellow)"/></g>',
  "javascript-react":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-sky)"><path d="M8 10.8c4.14 0 7.5-1.25 7.5-2.8S12.14 5.2 8 5.2S.5 6.45.5 8s3.36 2.8 7.5 2.8"/><path d="M5.52 9.4c2.07 3.5 4.86 5.72 6.23 4.95c1.37-.78.8-4.24-1.27-7.75C8.41 3.1 5.62.88 4.25 1.65c-1.37.78-.8 4.24 1.27 7.75"/><path d="M5.52 6.6c-2.07 3.5-2.64 6.97-1.27 7.75c1.37.77 4.16-1.45 6.23-4.95s2.64-6.97 1.27-7.75C10.38.88 7.59 3.1 5.52 6.6"/><path d="M8.5 8a.5.5 0 0 1-.5.5a.5.5 0 0 1-.5-.5a.5.5 0 0 1 .5-.5a.5.5 0 0 1 .5.5"/></g>',
  "javascript-test":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M12 7.5H4.98M9.5.5l6 6m-4.78-4.75l-8.49 8.48a2.5 2.5 0 1 0 3.54 3.54l8.48-8.49M15.5 12c-.33-.33-.83-.5-1.5-.5c-1 0-1.5.5-1.5 1s.5 1 1.5 1s1.5.5 1.5 1s-.5 1-1.5 1c-.67 0-1.17-.17-1.5-.5m-2-3.5v3a1 1 0 1 1-2 0" style="stroke:var(--ci-yellow)"/>',
  jest: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-red)"><path d="M7.5 6L5.56 1.5h9.94l-2 4.5"/><path d="m12.5 6l-2-2.5l-2 2.5m1 1.5h2m2 1.5c1 1-.5 2.75-3 4s-4.5 1.5-6 1.5c-2 0-3-1-3-2.9q0-1.35 1.5-2.1"/><path d="M7.5 9c0 1.5-2 2.5-3 2.5S3 11.25 3 9.5"/><path d="M4.5 8.5a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m5-1A1.5 1.5 0 0 1 8 9a1.5 1.5 0 0 1-1.5-1.5A1.5 1.5 0 0 1 8 6a1.5 1.5 0 0 1 1.5 1.5m5 0A1.5 1.5 0 0 1 13 9a1.5 1.5 0 0 1-1.5-1.5A1.5 1.5 0 0 1 13 6a1.5 1.5 0 0 1 1.5 1.5"/></g>',
  json: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.5 2.5H4c-.75 0-1.5.75-1.5 1.5v2c0 1.1-1 2-1.83 2c.83 0 1.83.9 1.83 2v2c0 .75.75 1.5 1.5 1.5h.5m7-11h.5c.75 0 1.5.75 1.5 1.5v2c0 1.1 1 2 1.83 2c-.83 0-1.83.9-1.83 2v2c0 .74-.75 1.5-1.5 1.5h-.5m-6.5-3a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m3 0a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1m3 0a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1" style="stroke:var(--ci-yellow)"/>',
  julia:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 5a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0" style="stroke:var(--ci-green)"/><path d="M6.5 11a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0" style="stroke:var(--ci-red)"/><path d="M14.5 11a2.5 2.5 0 1 1-5 0a2.5 2.5 0 0 1 5 0" style="stroke:var(--ci-mauve)"/></g>',
  jupyter:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2a.5.5 0 0 1-.5.5a.5.5 0 0 1-.5-.5a.5.5 0 0 1 .5-.5a.5.5 0 0 1 .5.5m12 0a.5.5 0 0 1-.5.5a.5.5 0 0 1-.5-.5a.5.5 0 0 1 .5-.5a.5.5 0 0 1 .5.5m-12 12a.5.5 0 0 1-.5.5a.5.5 0 0 1-.5-.5a.5.5 0 0 1 .5-.5a.5.5 0 0 1 .5.5" style="stroke:var(--ci-overlay)"/><path d="M1.5 9.5c1.67 2 3.83 3 6.5 3s4.83-1 6.5-3m-13-3c1.67-2 3.83-3 6.5-3s4.83 1 6.5 3" style="stroke:var(--ci-peach)"/></g>',
  just: '<circle cx="8" cy="8" r="6.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-text)"/><circle cx="8" cy="5" r="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-text)"/><circle cx="8" cy="11" r="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-text)"/>',
  key: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-text)"><path d="M10 10.5a4.5 4.5 0 1 0-4.02-2.48L1.5 12.5v2h2v-2h2v-2h2l.48-.48c.6.3 1.3.48 2.02.48"/><path d="M12 5a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1"/></g>',
  kotlin:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 13.5h11L8 8" style="stroke:var(--ci-mauve)"/><path d="M8.03 2.5h5.47l-8 8" style="stroke:var(--ci-peach)"/><path d="M2.5 13.5V8" style="stroke:var(--ci-red)"/><path d="M8 2.5H2.5V8l3-2.5" style="stroke:var(--ci-sapphire)"/></g>',
  latex:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M13 12.5h1.5m-.5-4l-3 4m0-4l3 4m-3.5 0h1m2-4l1.1.01m-4.1-.01h1.42m-4.42 4H9m-1.5-2v4m-.86 0h3.66l.2-.5m-3.75-3.5H10l.5.5M2 13.5h3m-1.5-5v5m-2-3.5l.25-1.5h3.5L5.5 10m4-3.5l2-5l2 5m-3-2h2M9 6.5h1m3 0h1m-9.5-5v5m-1-5h2m-2 5H7l.54-.99" style="stroke:var(--ci-text)"/>',
  less: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4 2.5c-.74 0-1.5.76-1.5 1.5v2c0 1.1-1.1 2-1.83 2c.74 0 1.83.9 1.83 2v2c0 .74.76 1.5 1.5 1.5m1.5-8v5a1 1 0 0 0 1 1H7m4.5-4c0-.69-.59-1-1.25-1h-.5c-.66 0-1.25.56-1.25 1.25S9.09 9 9.75 9h.5c.66 0 1.25.56 1.25 1.25s-.59 1.25-1.25 1.25h-.5c-.66 0-1.25-.31-1.25-1m3.5-8c.74 0 1.5.76 1.5 1.5v2c0 1.1 1.1 2 1.83 2c-.74 0-1.83.9-1.83 2v2c0 .74-.76 1.5-1.5 1.5" style="stroke:var(--ci-blue)"/>',
  license:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.5 13.5h7M8.01 1v12.06M1.5 3.5h3l1.5-1h4l1.5 1h3M.5 10L3 4.48L5.5 10C4 11 2 11 .5 10m10 0L13 4.48L15.5 10c-1.5 1-3.5 1-5 0" style="stroke:var(--ci-peach)"/>',
  lock: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.744" d="M12.36 7.104c.482 0 .872.39.872.872v5.23c0 .481-.39.871-.872.871H3.639a.87.87 0 0 1-.872-.871v-5.23c0-.482.39-.872.872-.872zm-6.977 0V4.488a2.617 2.617 0 0 1 5.234 0v2.616" style="stroke:var(--ci-overlay)"/>',
  log: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-text)"><path d="M4.5 3.5h9v11h-9z"/><path d="M11.5 3.45V1.5h-9v11h1.95m3.05-5h3m-3 3h3"/></g>',
  lua: '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 7A1.5 1.5 0 0 1 9 8.5A1.5 1.5 0 0 1 7.5 7A1.5 1.5 0 0 1 9 5.5A1.5 1.5 0 0 1 10.5 7" style="stroke:var(--ci-text)"/><path d="M7 2.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 0 0 0-13m7-2a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3" style="stroke:var(--ci-blue)"/></g>',
  makefile:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m9.24 8.47l-5.28 5.58c-.56.6-1.47.6-2.04 0a1.57 1.57 0 0 1 0-2.14L7.2 6.32" style="stroke:var(--ci-peach)"/><path d="m13.74 8.03l-.86-.93a2.46 2.46 0 0 1-.64-1.68v-.65l-1.89-2.04A3.7 3.7 0 0 0 7.63 1.5H5.5l.64.61A4.72 4.72 0 0 1 7.5 5.57v1.16l1.46 1.5h1.71l1.57 1.42m-.74.85l3-3" style="stroke:var(--ci-text)"/></g>',
  markdown:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m9.25 8.25l2.25 2.25l2.25-2.25M3.5 11V5.5l2.04 3l1.96-3V11m4-.5V5M1.65 2.5h12.7c.59 0 1.15.49 1.15 1v9c0 .51-.56 1-1.15 1H1.65c-.59 0-1.15-.49-1.15-1V3.58c0-.5.56-1.08 1.15-1.08" style="stroke:var(--ci-sapphire)"/>',
  "markdown-mdx":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m9.25 8.25l2.25 2.25l2.25-2.25M3.5 11V5.5l2.04 3l1.96-3V11m4-.5V5M1.65 2.5h12.7c.59 0 1.15.49 1.15 1v9c0 .51-.56 1-1.15 1H1.65c-.59 0-1.15-.49-1.15-1V3.58c0-.5.56-1.08 1.15-1.08" style="stroke:var(--ci-peach)"/>',
  mermaid:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M1.5 2.5c0 6 2.25 5.75 4 7c.83.67 1.17 2 1 4h3c-.17-2 .17-3.33 1-4c1.75-1.25 4-1 4-7C12 2.5 10 3 8 7C6 3 4 2.5 1.5 2.5" style="stroke:var(--ci-mauve)"/>',
  "ms-excel":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-green)"><path d="M2.5 3.13c0-.77.86-1.63 1.62-1.63h9.76c.76 0 1.62.86 1.62 1.63v9.75c0 .76-.86 1.62-1.62 1.62H4.13c-.77 0-1.63-.86-1.63-1.62M.5 5.5l4 5m0-5l-4 5"/><path d="M7.5 5.5h5v5h-5zm2 0v5m-2-3h5"/></g>',
  "ms-powerpoint":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-peach)"><path d="M2.5 3.13c0-.77.86-1.63 1.62-1.63h9.76c.76 0 1.62.86 1.62 1.63v9.75c0 .76-.86 1.62-1.62 1.62H4.13c-.77 0-1.63-.86-1.63-1.62"/><path d="M7.5 5.8L11.88 8L7.5 10.2zm-7-.3v5m0-2H2a1.5 1.5 0 0 0 0-3H.5"/></g>',
  "ms-word":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-blue)"><path d="M2.5 3.13c0-.77.86-1.63 1.62-1.63h9.76c.76 0 1.62.86 1.62 1.63v9.75c0 .76-.86 1.62-1.62 1.62H4.13c-.77 0-1.63-.86-1.63-1.62"/><path d="m.5 5.5l1 5l1-5l1 5l.97-5m3.03 1h4m-4 3h4"/></g>',
  nim: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M1 7L.5 4.5l1.01.67c.28-.27.47-.48 1.18-.85l.56-1.82L4.5 3.84c.77-.18 1.53-.36 2.4-.33L8 1.5l1.1 2.01c.87-.03 1.63.15 2.4.33l1.25-1.34l.56 1.82c.7.37.9.58 1.18.85l1.01-.67L15 7m-1.5 1C13 6.5 11 5.5 8 5.5S3 6.5 2.5 8m11.5.75L13.5 8l-1 1.5l-1.5.5l-3-1.5L5 10l-1.5-.5l-1-1.5l-.5.75L1 7l1.25 3.75C3 12.75 6 13.5 8 13.5s5-.75 5.75-2.75L15 7z" style="stroke:var(--ci-yellow)"/>',
  nix: '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M.5 7.5H4m1.39-2L2.05 11" style="stroke:var(--ci-sapphire)"/><path d="M4 1.5L5.5 4m3.5.5H2.55" style="stroke:var(--ci-blue)"/><path d="m12 1.5l-1.5 3m1.01 2.6L8.5 1.5" style="stroke:var(--ci-sapphire)"/><path d="M15.5 8.52L12 8.5m-1.38 2L14 5" style="stroke:var(--ci-blue)"/><path d="m12.5 14.5l-2.5-3m-2.97.02l6.48-.02" style="stroke:var(--ci-sapphire)"/><path d="m4 14.5l1.5-3M4.53 9l2.97 5.5" style="stroke:var(--ci-blue)"/></g>',
  npm: '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M2.45 1.5a.95.95 0 0 0-.95.95v11.1a.95.95 0 0 0 .95.95h11.1a.95.95 0 0 0 .95-.95V2.45a.95.95 0 0 0-.95-.95z" style="stroke:var(--ci-red)"/><path d="M4.5 4.5h7v7h-2v-5h-2v5h-3z" style="stroke:var(--ci-text)"/></g>',
  "npm-ignore":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-overlay)"><path d="M2.45 1.5a.95.95 0 0 0-.95.95v11.1a.95.95 0 0 0 .95.95h11.1a.95.95 0 0 0 .95-.95V2.45a.95.95 0 0 0-.95-.95z"/><path d="M4.5 4.5h7v7h-2v-5h-2v5h-3z"/></g>',
  "npm-lock":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M15 11.5c.27 0 .5.22.5.5v3a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-3c0-.28.22-.5.5-.5zm-4 0V10a1.5 1.5 0 0 1 3 0v1.5" style="stroke:var(--ci-overlay)"/><path d="M9.5 9V5.5h-2v6h-4v-8h8v3" style="stroke:var(--ci-text)"/><path d="M7.54 13.5H3A1.5 1.5 0 0 1 1.5 12V3c0-.83.67-1.5 1.5-1.5h9c.83 0 1.5.67 1.5 1.5v3.5" style="stroke:var(--ci-red)"/></g>',
  ocaml:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-peach)"><path d="M1.5 8V3c0-.83.67-1.5 1.5-1.5h10c.83 0 1.5.67 1.5 1.5v10c0 .83-.67 1.5-1.5 1.5H9"/><path d="m1.5 8l1.14-2.3q.09-.21.36-.24a.8.8 0 0 1 .44.13c.18.12.23.53.28.64c.06.1.64 1.23.85 1.23c.2 0 .71-1.47.71-1.47s.37-.49.72-.49s.55.32.67.49c.12.16.24 1.76.46 2.01s1.32.87 1.67.73c.34-.13.53-.4.63-.73c.1-.34-.14-.75 0-1a1.1 1.1 0 0 1 1.02-.55c.56.03 2.05.56 2.05 1.05q0 .75-1.5.75c-.48 1.33.28 2.22-3 2.25l1 4"/><path d="m4.5 14.5l1.5-4l1 4zm-2 0l1.5-4l-1.5-.5l-1 1.54V14l1 .49Z"/></g>',
  org: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" d="M2.287 10.409C1.95 11.15.888 12.95 2 15.48M9.56 9.5s-1.911 2.816 1.085 5.55m-.372-11.662L13.5.5l-1.96 3.986" style="stroke:var(--ci-teal)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" d="M8 7.467c.344 2.288 2.827 1.646 3.575 1.66c.094.003.346.157.425.208l.994.47c.116.073.264.124.389.069l.467-.207a.77.77 0 0 0 .603-.673l.049-.461a.77.77 0 0 0-.206-.612L11.5 4.5l-1.5-1v-2s-2.19.261-2 1.925c0 0-4.434 1.764-1.513 5.867c0 0 .79 1.51.018 3.16" style="stroke:var(--ci-teal)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" d="M8 3s-6.4.163-4 6" style="stroke:var(--ci-teal)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-miterlimit="10" d="M3.526 6s-3.462 2.329-.025 6c0 0 .979 1.518.499 3.497" style="stroke:var(--ci-teal)"/>',
  "package-json":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M11.5 6.5v-.17c0-.73-.6-1.33-1.33-1.33H9a1.5 1.5 0 1 0 0 3h1a1.5 1.5 0 0 1 0 3H9a1.5 1.5 0 0 1-1.5-1.5M5.5 5v4.5c0 1.5-.08 1.87-.71 2.5c-.5.5-1.5.5-1.5.5c-.96-.4-1.2-.66-1.79-1v-7L8 .5l6.5 4v7l-6.5 4l-2.49-1.53" style="stroke:var(--ci-green)"/>',
  pdf: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M2.8 14.34c1.81-1.25 3.02-3.16 3.91-5.5c.9-2.33 1.86-4.33 1.44-6.63c-.06-.36-.57-.73-.83-.7c-1.02.06-.95 1.21-.85 1.9c.24 1.71 1.56 3.7 2.84 5.56c1.27 1.87 2.32 2.16 3.78 2.26c.5.03 1.25-.14 1.37-.58c.77-2.8-9.02-.54-12.28 2.08c-.4.33-.86 1-.6 1.46c.2.36.87.4 1.23.15h0Z" style="stroke:var(--ci-red)"/>',
  perl: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M12.5 14.5v-3.34c-1-.66-1-1.35-1-2.66m-3 1l.02 2.53l.98 2.47m-4-5v5m9 0V9.23s.17-1.73-1-1.73c0-1.5-.5-6-2.5-6S8.75 4.25 8.75 4.25A3.67 3.67 0 0 0 6.5 7.12v-3.5c0-.63-.85-1.32-1.5-1.32c-.92 0-1.33.59-1.5 1.2H2.25c-.42.11-.75.59-.75 1c0 .5.28 1 .75 1h1.22l.02 3c.01.75.51 1 1.51 1h4.5" style="stroke:var(--ci-blue)"/>',
  php: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M.5 12.5v.74c0 .76.774 1.26 1.5 1.26c.938 0 1.5-.5 1.5-1.255V6c0-1.715 1.494-3.478 3.65-3.501c2.344 0 3.85 1.558 3.85 3c.166 2.99-1.422 4.137-3.504 5v4h8.002V9c.041-.635-.56-1.844-1.367-2.5c-.937-.692-2.073-.997-3.131-1m.5 9v-3M6 6.5a.5.5 0 1 0 0-1a.5.5 0 0 0 0 1" style="stroke:var(--ci-blue)"/>',
  pnpm: '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v4" style="stroke:var(--ci-peach)"/><path d="M10 9.5V14M6 6v8" style="stroke:var(--ci-text)"/><path d="M10 2v7.5m4 .5V2H2v4h12" style="stroke:var(--ci-peach)"/><path d="M2 10v4h12v-4z" style="stroke:var(--ci-text)"/></g>',
  "pnpm-lock":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M15 11.5c.27 0 .5.22.5.5v3a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-3c0-.28.22-.5.5-.5zm-4 0V10a1.5 1.5 0 0 1 3 0v1.5" style="stroke:var(--ci-overlay)"/><path d="M4.5 1.5v3" style="stroke:var(--ci-peach)"/><path d="M7.5 7.5v3m-3-6v6" style="stroke:var(--ci-text)"/><path d="M7.5 1.5v6m3 0v-6h-9v3h9" style="stroke:var(--ci-peach)"/><path d="M10.5 7.5h-9v3h7" style="stroke:var(--ci-text)"/></g>',
  powershell:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-blue)"><path d="M2 15.5c-.7 0-1.5-.8-1.5-1.5V5c0-.7.8-1.5 1.5-1.5h9c.7 0 1.5.8 1.5 1.5v9c0 .7-.8 1.5-1.5 1.5z"/><path d="m1.2 3.8l3.04-2.5S5.17.5 5.7.5h8.4c.66 0 1.4.73 1.4 1.4v7.73a2.7 2.7 0 0 1-.7 1.75l-2.68 3.51M3 8.5l3 2l-3 2m4 0h2"/></g>',
  prettier:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 2.5h11m-11 6h5" style="stroke:var(--ci-sapphire)"/><path d="M1.5 4.5h5m3 4h5" style="stroke:var(--ci-yellow)"/><path d="M9.5 4.5h5m-13 2h5m-5 6h5" style="stroke:var(--ci-mauve)"/><path d="M9.5 6.5h5m-13 4h11m-11 4h5" style="stroke:var(--ci-red)"/></g>',
  "prettier-ignore":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M1.5 2.5h11m-11 6h5m-5-4h5m3 4h5m-5-4h5m-13 2h5m-5 6h5m3-6h5m-13 4h11m-11 4h5" style="stroke:var(--ci-overlay)"/>',
  prisma:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m8 .5l6.5 12.05l-10 2.95l-3-5zm-3.5 15L8 .5" style="stroke:var(--ci-teal)"/>',
  properties:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M8 1.5c-.87 0-1.17 1.32-2.03 1.63c-.86.3-2.17-.68-2.84 0c-.68.67.3 1.98 0 2.84S1.5 7.13 1.5 8s1.32 1.17 1.63 2.03c.3.86-.68 2.17 0 2.85c.67.67 1.98-.3 2.84 0c.85.3 1.16 1.62 2.03 1.62s1.17-1.32 2.03-1.63c.86-.3 2.17.68 2.85 0c.67-.67-.3-1.98 0-2.84c.3-.85 1.62-1.16 1.62-2.03s-1.32-1.17-1.63-2.03c-.3-.86.68-2.17 0-2.84c-.67-.68-1.98.3-2.84 0S8.87 1.5 8 1.5m0 9a2.5 2.5 0 1 0 0-5a2.5 2.5 0 0 0 0 5" style="stroke:var(--ci-text)"/>',
  proto:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m.5 8.5l3-6h3l-3 6" style="stroke:var(--ci-red)"/><path d="M6.5 13.5h-3l-3-5l1.36-2.73z" style="stroke:var(--ci-blue)"/><path d="m15.5 7.5l-3 6h-3l3-6" style="stroke:var(--ci-yellow)"/><path d="M9.5 2.5h3l3 5l-1.36 2.73z" style="stroke:var(--ci-green)"/></g>',
  python:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 5.5h-3m6 0V3c0-.8-.7-1.5-1.5-1.5H7c-.8 0-1.5.7-1.5 1.5v2.5H3c-.8 0-1.5.7-1.5 1.5v2c0 .8.7 1.5 1.48 1.5" style="stroke:var(--ci-blue)"/><path d="M10.5 10.5h-3m-3 0V13c0 .8.7 1.5 1.5 1.5h3c.8 0 1.5-.7 1.5-1.5v-2.5H13c.8 0 1.5-.7 1.5-1.5V7c0-.8-.7-1.5-1.48-1.5H11.5c0 1.5 0 2-1 2h-2" style="stroke:var(--ci-yellow)"/><path d="M2.98 10.5H4.5c0-1.5 0-2 1-2h2m0-5" style="stroke:var(--ci-blue)"/></g>',
  "python-compiled":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 5.5h-3m6 0V3c0-.8-.7-1.5-1.5-1.5H7c-.8 0-1.5.7-1.5 1.5v2.5H3c-.8 0-1.5.7-1.5 1.5v2c0 .8.7 1.5 1.48 1.5" style="stroke:var(--ci-text)"/><path d="M10.5 10.5h-3m-3 0V13c0 .8.7 1.5 1.5 1.5h3c.8 0 1.5-.7 1.5-1.5v-2.5H13c.8 0 1.5-.7 1.5-1.5V7c0-.8-.7-1.5-1.48-1.5H11.5c0 1.5 0 2-1 2h-2" style="stroke:var(--ci-overlay)"/><path d="M2.98 10.5H4.5c0-1.5 0-2 1-2h2m0-5" style="stroke:var(--ci-text)"/></g>',
  "python-config":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M11.5 13.5a1 1 0 1 0 0-2a1 1 0 0 0 0 2m1.75-4l1.75 3l-1.75 3h-3.5L8 12.5l1.75-3z" style="stroke:var(--ci-overlay)"/><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M6.961 4.192h-2.77m5.54 0V1.884C9.73 1.146 9.083.5 8.345.5h-2.77c-.738 0-1.384.646-1.384 1.384v2.308H1.884C1.146 4.192.5 4.838.5 5.577v1.846c0 .738.646 1.384 1.366 1.384" style="stroke:var(--ci-blue)"/><path d="M8.115 8.807H6.038m-2.77 0v2.308c0 .739.647 1.385 1.385 1.385h1.385m6.35-4.55c.071-.164.112-.343.112-.527V5.577c0-.739-.646-1.385-1.366-1.385H9.73c0 1.385 0 1.846-.923 1.846H6.961" style="stroke:var(--ci-yellow)"/><path d="M1.866 8.807h1.403c0-1.384 0-1.846.923-1.846h1.846m0-4.615" style="stroke:var(--ci-blue)"/></g>',
  r: '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 9.5c.63-.7 1-1.54 1-2.43c0-2.52-2.91-4.57-6.5-4.57S1.5 4.55 1.5 7.07c0 1.9 1.65 3.53 4 4.22" style="stroke:var(--ci-overlay)"/><path d="M10.5 9.5c.4 0 .86.34 1 .7l1 3.3m-5 0v-8h3.05c.95 0 1.95 1 1.95 2s-1 2-1.95 2H7.5Z" style="stroke:var(--ci-blue)"/></g>',
  readme:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-teal)"><path d="M8 14.5a6.5 6.5 0 1 0 0-13a6.5 6.5 0 0 0 0 13"/><path d="M7 7.5h2v5H7Zm2-3a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1"/></g>',
  rmd: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M7.008 15.04s.816-6.045 3.515-8.38c2.83-2.446 4.302-.674 4.302-.674s2.896 2.756-5.399 5.68c0 0 1.912 4.218 6.074 2.98" style="stroke:var(--ci-blue)"/><path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M.5 15.048a6.5 6.5 0 0 1 1.616-2.932S4.253.84 13.897.952l-1.153 2.812S8.02 4.411 5.8 11.807c0 0-1.855.534-3.683.309" style="stroke:var(--ci-blue)"/>',
  robots:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-mauve)"><path d="M3.5 5.5h9a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1"/><path d="M6.5 9a.5.5 0 0 1-.5.5a.5.5 0 0 1-.5-.5a.5.5 0 0 1 .5-.5a.5.5 0 0 1 .5.5m4 0a.5.5 0 0 1-.5.5a.5.5 0 0 1-.5-.5a.5.5 0 0 1 .5-.5a.5.5 0 0 1 .5.5M8 5.5v-2m-7.5 5v3m15-3v3M9 2.5a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m-2.5 10h3"/></g>',
  rollup:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M4.37 14.5h9.13l-2-5c1.36-1.08 2-2.13 2-4c0-2.4-2.25-3.97-4-4h-7v11.3" style="stroke:var(--ci-red)"/><path d="M11.46 6.2c-3.25 3.32-4.37 4.25-7.2 8.3c-1.03-.13-1.67-.61-1.74-1.55c-.36-.35 4.87-8.22 5.42-9.16c.6-1 2.55-2.22 3.78-1.4c-1.18-.38-2.58.56-2.41 1.5l.47 1.89c.34.58.66.8 1.18.73c.56-.16.67-.53.63-1l-.36-.99" style="stroke:var(--ci-yellow)"/></g>',
  ruby: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M1.5 9.06v2.5c.02.86.36 1.61.9 2.15c1.76 1.76 5.71.65 8.84-2.47c3.12-3.13 4.23-7.08 2.47-8.84a3.1 3.1 0 0 0-2.15-.9h-2.5M14.5 4l-.25 10.25L4 14.5m4.39-6.11c2.34-2.35 3.29-5.2 2.12-6.37S6.49 1.8 4.14 4.14C1.8 6.5.85 9.34 2.02 10.51s4.02.22 6.37-2.12M5.5 14.5l.25-3.75L11 11l-.25-5.25l3.75-.25" style="stroke:var(--ci-red)"/>',
  rust: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-peach)"><path d="M15.5 9.5Q8 13.505.5 9.5l1-1l-1-2l2-.5V4.5h2l.5-2l1.5 1l1.5-2l1.5 2l1.5-1l.5 2h2V6l2 .5l-1 2z"/><path d="M6.5 7.5a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1m5 0a1 1 0 0 1-1 1a1 1 0 0 1-1-1a1 1 0 0 1 1-1a1 1 0 0 1 1 1M4 11.02c-.67.37-1.5.98-1.5 2.23s1.22 1.22 2 1.25v-2M12 11c.67.37 1.5 1 1.5 2.25s-1.22 1.22-2 1.25v-2"/></g>',
  sass: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M6.75 6.38c1.85 1.07 3.35.74 4.83-.2c1.5-.95 2.7-2.78 1.3-4.15c-.7-.68-3.25-.8-5.62.19c-2.36.99-4.59 3.02-4.74 4.11c-.31 2.19 3.15 2.88 3.64 4.23s.28 1.98-.2 2.83c-.5.85-1.96 1.62-2.8.68c-.83-.95 1.67-2.75 2.98-3.25c1.3-.5 3.1-.4 3.69.25c.58.64-.07 1.79-.03 1.79" style="stroke:var(--ci-pink)"/>',
  scala:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m2.5 2.48l11-.98v3.04l-11 1zm0 5l11-.98v3.04l-11 1zm0 5l11-.98v3.04l-11 1z" style="stroke:var(--ci-red)"/>',
  shader:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M6.41 12c0 .9-.47 1.72-1.23 2.17c-.76.44-1.7.44-2.45 0A2.5 2.5 0 0 1 1.5 12c0-1.38 1.1-2.5 2.46-2.5A2.48 2.48 0 0 1 6.4 12h0Zm3.78-7.23A2.85 2.85 0 0 0 4.6 3.6a2.9 2.9 0 0 0 1.77 3.5c2.19.88 2.7 1.75 2.43 4.13a2.85 2.85 0 0 0 5.58 1.17a2.9 2.9 0 0 0-1.77-3.5c-2.19-.88-2.7-1.76-2.43-4.13h0Z" style="stroke:var(--ci-mauve)"/>',
  solidity:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m3 11.5l2.5 4l2.5-4l2.5 4l2.5-4l-2.5-4l-2.5 4m2.5 4h-5m7.5-4H3m10-7l-2.5-4l-2.5 4l-2.5-4l-2.5 4l2.5 4l2.5-4M5.5.5h5M3 4.5h10" style="stroke:var(--ci-mauve)"/>',
  svelte:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-peach)"><path d="M12.86 6.72s1.39-1.98.08-3.87C11.286.763 9.44 1.6 9.44 1.6S6.15 3.35 4.33 4.59c-1.4 1-2.24 2.26-1.03 4.37c1.22 2.1 4.58 1.21 4.58 1.21"/><path d="M3.14 9.28s-1.39 1.98-.08 3.87c1.31 1.9 3.5 1.24 3.5 1.24s3.29-1.74 5.11-2.98c1.4-1 2.24-2.26 1.03-4.37c-1.22-2.1-4.58-1.21-4.58-1.21M6.3 6.96l4.14-2.56m-4.92 7.25L9.66 9.1"/></g>',
  svg: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m4.54 10l6.92-4m-6.92 4a1.5 1.5 0 1 0-2.6 1.5a1.5 1.5 0 0 0 2.6-1.5M8 4v8m0-8a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3M4.54 6l6.92 4M4.54 6a1.5 1.5 0 1 0-2.6-1.5A1.5 1.5 0 0 0 4.54 6M8 12a1.5 1.5 0 1 0 0 3a1.5 1.5 0 0 0 0-3m3.46-2a1.5 1.5 0 1 0 2.6 1.5a1.5 1.5 0 0 0-2.6-1.5m0-4a1.5 1.5 0 1 0 2.6-1.5a1.5 1.5 0 0 0-2.6 1.5" style="stroke:var(--ci-peach)"/>',
  swift:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M14.34 10.2c.34-1.08 1.1-5.07-4.45-8.62a.48.48 0 0 0-.6.07a.44.44 0 0 0-.02.6c.03.02 2.07 2.5 1.34 5.34c-1.26-.86-6.24-4.81-6.24-4.81L7.25 7.5L1.9 4.05S5.68 8.7 8 10.45c-1.12.4-3.56.82-6.78-1.18a.48.48 0 0 0-.58.06a.44.44 0 0 0-.08.56c.11.18 2.7 4.36 8.14 4.36c1.5 0 2.37-.42 3.08-.77c.43-.2.77-.37 1.14-.37c.93 0 1.54.92 1.54.93c.1.14.27.22.44.21a.46.46 0 0 0 .4-.28c.67-1.55-.49-3.2-.96-3.78h0Z" style="stroke:var(--ci-peach)"/>',
  tailwind:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M8 2.5q-3 0-3.75 3.33C5 4.73 5.88 4.31 6.87 4.58c.58.16.98.62 1.43 1.13c.74.83 1.6 1.79 3.45 1.79q3 0 3.75-3.33c-.75 1.1-1.63 1.52-2.63 1.25c-.57-.16-.97-.62-1.42-1.13C10.7 3.46 9.85 2.5 8 2.5m-3.75 6q-3 0-3.75 3.33c.75-1.1 1.63-1.52 2.63-1.25c.57.16.97.62 1.42 1.13c.74.83 1.6 1.79 3.45 1.79q3 0 3.75-3.33c-.75 1.1-1.63 1.52-2.62 1.25c-.58-.16-.98-.62-1.43-1.13c-.74-.83-1.6-1.79-3.45-1.79" style="stroke:var(--ci-sapphire)"/>',
  terraform:
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="m1.5 6l8 4.25l4-2.25m-12-2V1.5l8 4.25l4-2.25V8m-4-2.25v8.75M5.53 3.82L5.5 12.5l4 2" style="stroke:var(--ci-mauve)"/>',
  text: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-text)"><path d="M13.5 6.5v6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h4.01"/><path d="m8.5 1.5l5 5h-4a1 1 0 0 1-1-1zm-3 10h5m-5-3h5m-5-3h1"/></g>',
  todo: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-green)"><path d="M14.5 8A6.5 6.5 0 0 1 8 14.5A6.5 6.5 0 0 1 1.5 8A6.5 6.5 0 0 1 8 1.5A6.5 6.5 0 0 1 14.5 8"/><path d="m4.5 7.5l2.5 3l4.5-5"/></g>',
  toml: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M3.5 1.5h-2v13h2m9-13h2v13h-2m-8-11h7v3h-2v6h-3v-6h-2z" style="stroke:var(--ci-maroon)"/>',
  typescript:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-blue)"><path d="M4 1.5h8A2.5 2.5 0 0 1 14.5 4v8a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.5 12V4A2.5 2.5 0 0 1 4 1.5"/><path d="M12.5 8.75c0-.69-.54-1.25-1.2-1.25h-.6c-.66 0-1.2.56-1.2 1.25S10.04 10 10.7 10h.6c.66 0 1.2.56 1.2 1.25s-.54 1.25-1.2 1.25h-.6c-.66 0-1.2-.56-1.2-1.25m-3-3.75v5M5 7.5h3"/></g>',
  "typescript-config":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 13.5a1 1 0 1 0 0-2a1 1 0 0 0 0 2m1.75-4l1.75 3l-1.75 3h-3.5L8 12.5l1.75-3z" style="stroke:var(--ci-overlay)"/><path d="M6.5 11.5h-4a2 2 0 0 1-2-2v-7c0-1.1.9-2 2-2h7.97c1.1 0 2 .92 2 2V7" style="stroke:var(--ci-blue)"/><path d="M10.5 4.5C10.17 4.17 9.67 4 9 4c-1 0-1.5.5-1.5 1S8 6 9 6s1.5.5 1.5 1S10 8 9 8c-.67 0-1.17-.17-1.5-.5M4 4v4M2.5 4h3" style="stroke:var(--ci-blue)"/></g>',
  "typescript-def":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 4.5h1a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V10" style="stroke:var(--ci-blue)"/><path d="M13.5 9c-.33-.33-.83-.5-1.5-.5c-1 0-1.5.5-1.5 1s.5 1 1.5 1s1.5.5 1.5 1s-.5 1-1.5 1c-.67 0-1.17-.17-1.5-.5M8 8.5v4m-1.5-4h3" style="stroke:var(--ci-blue)"/><path d="M2.04 7.88L.5 3.02c-.05-.15.06-.31.23-.37L7.54.52c.1-.04.21-.02.3.04l2.63 1.84c.1.07.13.19.1.3L9.44 5.72a.34.34 0 0 1-.22.2l-6.8 2.13a.31.31 0 0 1-.4-.17Zm5.13-3.23a1.21 1.21 0 1 0 .62-2.35a1.21 1.21 0 0 0-.62 2.35" style="stroke:var(--ci-sapphire)"/></g>',
  "typescript-react":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-blue)"><path d="M8 11.3c4.14 0 7.5-1.28 7.5-2.86S12.14 5.58 8 5.58S.5 6.86.5 8.44s3.36 2.87 7.5 2.87Z"/><path d="M5.52 9.87c2.07 3.6 4.86 5.86 6.23 5.07c1.37-.8.8-4.34-1.27-7.93S5.62 1.16 4.25 1.95s-.8 4.34 1.27 7.92"/><path d="M5.52 7.01c-2.07 3.59-2.64 7.14-1.27 7.93s4.16-1.48 6.23-5.07c2.07-3.58 2.64-7.13 1.27-7.92c-1.37-.8-4.16 1.47-6.23 5.06"/><path d="M8.5 8.44a.5.5 0 0 1-.5.5a.5.5 0 0 1-.5-.5a.5.5 0 0 1 .5-.5a.5.5 0 0 1 .5.5"/></g>',
  "typescript-test":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M15.5 12c-.33-.33-.83-.5-1.5-.5c-1 0-1.5.5-1.5 1s.5 1 1.5 1s1.5.5 1.5 1s-.5 1-1.5 1c-.67 0-1.17-.17-1.5-.5m-3-3.5v4m-1.5-4h3m-.28-9.75l-8.49 8.48a2.5 2.5 0 1 0 3.54 3.54l.77-.77m3.59-3.59l.59-.59l1.17-1.18l2.36-2.36M9.5.5l6 6m-3.5 1H4.98" style="stroke:var(--ci-blue)"/>',
  uv: '<path fill="none" stroke-linejoin="round" d="M1 1h5.8v9.1h2.8V1H15v14h-2v-1.4h-1.5c-.2.8-.9 1.4-1.8 1.4H3.2C1.9 15 1 14 1 12.9z" style="stroke:var(--ci-pink)"/>',
  video:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-sapphire)"><path d="M3 2.5h10c.83 0 1.5.67 1.5 1.5v9c0 .83-.67 1.5-1.5 1.5H3A1.5 1.5 0 0 1 1.5 13V4c0-.83.67-1.5 1.5-1.5m-1.5 3h13"/><path d="m3.5 5.5l2-3m1.5 3l2-3m1.5 3l2-3M6.5 8v4l4-2z"/></g>',
  vim: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M1.5 2.5h4m-3 0v11h3l8-11H11l-6.5 9v-9m10 0H9" style="stroke:var(--ci-green)"/>',
  vite: '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m11 5.5l3.5-1l-6.5 11l-6.5-11l3.5 1" style="stroke:var(--ci-mauve)"/><path d="m6 1.5l-.5 5l2-1l-1 3L8 8v3l4-7.5l-2 .5L11.5.5Z" style="stroke:var(--ci-yellow)"/></g>',
  vitest:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 8.5l-6.5 6l-6.5-6" style="stroke:var(--ci-green)"/><path d="M7.5 11.5L8 8L5 7l4.5-5.5L9 5l3 1z" style="stroke:var(--ci-yellow)"/></g>',
  vue: '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-green)"><path d="M1 1.5h5.44L8 4.56L9.56 1.5H15l-6.99 13z"/><path d="M12.05 1.73L8 9.28L3.95 1.73"/></g>',
  "web-assembly":
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round" style="stroke:var(--ci-mauve)"><path d="m9.5 12.5l1.5-4l1.5 4m-2.5-1h2m-8.5-3l1 4l1.5-4l1.5 4l1-4"/><path d="M10.5 1.5h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2v0"/><path d="M5.5 1.5c0 1.38.5 3 2.5 3s2.5-1.62 2.5-3"/></g>',
  webpack:
    '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 10.02l-3 1.73M11.47 10l3.03 1.75M8 4V.5" style="stroke:var(--ci-sky)"/><path d="M11.5 10L8 12l-3.5-2V6L8 4l3.5 2z" style="stroke:var(--ci-blue)"/><path d="M14.5 11.75L8 15.5l-6.5-3.75v-7.5L8 .5l6.5 3.75zm-13-7.5L8 8m6.5-3.75L8 8m0 0v7.5" style="stroke:var(--ci-sky)"/></g>',
  xml: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M4.5 4.5L1 8l3.5 3.5m7-7L15 8l-3.5 3.5M9.5 2l-3 12" style="stroke:var(--ci-peach)"/>',
  yaml: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M2.5 1.5h3l3 4l3-4h3l-9 13h-3L7 8z" style="stroke:var(--ci-red)"/>',
  "yarn-lock":
    '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M15 11.5c.27 0 .5.22.5.5v3a.5.5 0 0 1-.5.5h-5a.5.5 0 0 1-.5-.5v-3c0-.28.22-.5.5-.5zm-4 0V10a1.5 1.5 0 0 1 3 0v1.5" style="stroke:var(--ci-overlay)"/><g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="7.179" style="stroke:var(--ci-mauve)"><path d="M58.19 92.889c-2.438 1.472-16.058 7.342-33.033.927c0 0-15.323 4.247-14.195-6.503c0 0-10.684-12.422.938-22.28c0 0-1.241-16.91 11.549-24.936c0 0-8.286-12.228 0-19.036s12.645-9.145 18.736-8.634c0 0 7.247-20.251 14.643 0c0 0 9.061-7.776 7.844 17.247c-.323 6.646-4.717 16.289-7.844 20.326c0 0 2.22 1.58 4.44 5.612c1.11 2.015 2.22 4.643 3.053 7.992a45 45 0 0 1 1.006 5.578" transform="matrix(.13927 0 0 .13933 -.413 .02)"/><path d="M27.469 94.285c-1.525-1.407.321-8.703.321-8.703s-1.252 4.723-3.116 7.525" transform="matrix(.13927 0 0 .13933 -.413 .02)"/></g>',
  zig: '<path fill="none" stroke-linecap="round" stroke-linejoin="round" d="M10 3.5H6l-1.5 2h4l-7 9l4.5-2h4l1.5-2h-4l7-9z" style="stroke:var(--ci-yellow)"/>',
  zip: '<path fill="none" stroke-linejoin="round" d="M5.5 10v1m1-2v1m-1-2v1m1-2v1m-1-2v1m1-2v1m-1-2v1m0-3v1m1 0v1m7 2.5v6a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h4.01m-.01 0l5 5h-4a1 1 0 0 1-1-1z" style="stroke:var(--ci-text)"/>',
};
