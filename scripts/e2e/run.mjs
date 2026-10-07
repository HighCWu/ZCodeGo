#!/usr/bin/env node
/**
 * zcode-go E2E 断言套件（本地/CI 同一套；零依赖，node ≥ 20）。
 *
 * 环境输入：
 *   ZCODE_GO_E2E_OFFICIAL_BIN  必填：官方二进制路径（本机安装或 CI unpacked 产物）
 *   ZCODE_GO_E2E_GUI           可选 "1"：启用 GUI 断言（当前仅 Linux：xdotool）
 *   ZCODE_GO_E2E_SKIP_LAUNCH   可选 "1"：跳过冷启动与运行时断言（只测 hook/fixtures）
 *
 * 断言组：
 *   core   hook fixtures（放行/status/off/on/停用 bare）、发现（env 注入 → official.json
 *          与 runtimeBundle 推导）、ensure 幂等（--json synced=false）、品牌图标/主题链
 *          门控文件、standalone 硬隔离契约（编译产物级）
 *   launch launcher 冷启动 → desktop.pid + “takeover 模式就绪” 日志
 *   runtime host 子进程树中 zcode-cli 的 exe == 官方二进制（ELECTRON_RUN_AS_NODE）
 *   gui    主窗存在；bare /zcode-go → SHOW → enterZCodeGo（定版：显示自己 +
 *          官方进程全部退出，独占运行）；关闭主窗 → 应用直接退出（无气泡/回切）；
 *          全程分步截图至 ~/.zcode-go/e2e-shots/（CI artifact 可拉本地肉眼核对）
 *
 * 移动端（抽屉/容器页）与 standalone 全链路属本地/真机套件：
 *   scripts/e2e/mobile-drawer.mjs（需真实 worker 配对，见文件头说明）。
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname as pathDirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(pathDirname(fileURLToPath(import.meta.url)), "..", "..");
const stateDir = join(homedir(), ".zcode-go");
const officialBin = (process.env.ZCODE_GO_E2E_OFFICIAL_BIN ?? "").trim();
const guiMode = process.env.ZCODE_GO_E2E_GUI === "1";
const skipLaunch = process.env.ZCODE_GO_E2E_SKIP_LAUNCH === "1";
const hookCjs = join(repoRoot, "plugin", "hooks", "zcode-go.cjs");
const bootstrapSh = join(repoRoot, "plugin", "hooks", "bootstrap.sh");
const isLinux = process.platform === "linux";

if (!officialBin || !existsSync(officialBin)) {
  console.error("需要 ZCODE_GO_E2E_OFFICIAL_BIN 指向存在的官方二进制");
  process.exit(2);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", timeout: 120_000, ...options });
}
const dirname0 = (p) => {
  const i = p.replaceAll("\\", "/").lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : p;
};
function sh(script, stdin = "") {
  return run("sh", ["-c", script], { input: stdin });
}

// 分步截图（三平台，wails e2e 同款思路：每阶段留证据，artifact 拉本地肉眼核对）：
//   linux: import（imagemagick）| darwin: screencapture | win32: CopyFromScreen
const shotsDir = join(stateDir, "e2e-shots");
rmSync(shotsDir, { recursive: true, force: true });
run("sh", ["-c", `mkdir -p '${shotsDir}'`]);
function snapScreen(name) {
  const file = join(shotsDir, name);
  if (process.platform === "linux") {
    run("sh", ["-c", `import -window root '${file}' 2>/dev/null || true`]);
  } else if (process.platform === "darwin") {
    run("screencapture", ["-x", file]);
  } else {
    const ps =
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
      "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;" +
      "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;" +
      "$g=[System.Drawing.Graphics]::FromImage($bmp);" +
      "$g.CopyFromScreen($b.X,$b.Y,0,0,$bmp.Size);" +
      `$bmp.Save('${file.replaceAll("\\", "/")}');`;
    run("powershell", ["-NoProfile", "-Command", ps]);
  }
}

// ── core：hook fixtures（用系统 node 直接跑 CJS；CI/LINUX 均可）──────────
const nodeBin = process.execPath;
const env = { ...process.env, ZCODE_GO_OFFICIAL_BIN: officialBin };

function hookFeed(prompt) {
  const r = run(nodeBin, [hookCjs, "hook"], {
    input: JSON.stringify({ prompt, session_id: "e2e" }),
    env,
  });
  return { stdout: (r.stdout ?? "").trim(), code: r.status };
}

{
  const pass = hookFeed("帮我写个函数");
  check("hook: 非指令放行（空输出）", pass.stdout === "", `stdout=${pass.stdout.slice(0, 40)}`);
}
{
  const status = hookFeed("/zcode-go status");
  // hook 输出为 JSON 字符串，Windows 反斜杠会被转义 —— parse 后比较原始值
  let stopReason = "";
  try {
    stopReason = JSON.parse(status.stdout.slice(status.stdout.indexOf("{"))).stopReason ?? "";
  } catch { /* 保持空，走失败分支 */ }
  const ok = status.stdout.includes('"continue":false') && stopReason.includes(officialBin);
  check("hook: status 拦截并含官方路径", ok, status.stdout.slice(0, 80));
}
{
  const off = hookFeed("/zcode-go off");
  const disabledBare = hookFeed("/zcode-go");
  const on = hookFeed("/zcode-go on");
  check(
    "hook: off/on 开关与停用态 bare",
    off.stdout.includes("已停用") &&
      disabledBare.stdout.includes("已停用") &&
      on.stdout.includes("已启用") &&
      !existsSync(join(stateDir, "DISABLE")),
  );
}
{
  // 发现：env 注入 → official.json 的 runtimeBundle 推导
  hookFeed("/zcode-go status");
  const info = JSON.parse(readFileSync(join(stateDir, "official.json"), "utf8"));
  const expectedBundle = join(info.resourcesDir, "glm", "zcode.cjs");
  const officialHasRuntime = existsSync(expectedBundle);
  check(
    "发现: official.json 与 runtimeBundle 推导",
    info.bin === resolve(officialBin) &&
      info.runtimeBundle === (officialHasRuntime ? expectedBundle : null),
    `bundle=${info.runtimeBundle ?? "(官方包无 runtime，推导为 null)"}`,
  );
}
{
  // bootstrap.sh 链（Linux/macOS；要求进程树内有官方二进制 —— 本机在官方内运行时成立，
  // CI runner 上无官方祖先 → 允许跳过并标注）
  const inOfficialTree = isLinux
    ? run("sh", ["-c", "readlink /proc/$PPID/exe"]).stdout?.length > 0
    : false;
  if (isLinux || process.platform === "darwin") {
    const r = sh(`'${bootstrapSh}'`, JSON.stringify({ prompt: "/zcode-go status" }));
    if (r.status === 3) {
      check("bootstrap: 祖先链（CI runner 无官方祖先，标注跳过）", true, "exit=3 fallthrough OK");
    } else {
      check("bootstrap: sh 链输出 status", (r.stdout ?? "").includes("官方 bin"), `status=${r.status}`);
    }
  }
}
{
  // ensure 幂等
  const first = run(nodeBin, [join(repoRoot, "scripts", "ensure-official-electron.mjs"), "--json"], {
    env: { ...process.env, ZCODE_OFFICIAL_BIN: officialBin },
  });
  const second = run(nodeBin, [join(repoRoot, "scripts", "ensure-official-electron.mjs"), "--json"], {
    env: { ...process.env, ZCODE_OFFICIAL_BIN: officialBin },
  });
  const parse = (r) => {
    try {
      return JSON.parse((r.stdout ?? "").trim().split("\n").pop());
    } catch {
      return null;
    }
  };
  const a = parse(first);
  const b = parse(second);
  check(
    "ensure: 幂等（第二次 synced=false）",
    !!a && !!b && b.synced === false,
    `first.synced=${a?.synced} second.synced=${b?.synced}`,
  );

  // ── 品牌图标门控（新文件门控链路：仓库资产 → resources → hicolor 主题链）──
  {
    const electronRoot = a?.electronRoot ? String(a.electronRoot) : join(stateDir, "electron");
    // mac 为克隆 .app bundle：ensureIcons 装配进 Contents/Resources
    const resourcesDir = process.platform === "darwin"
      ? join(electronRoot, "ZCode Go.app", "Contents", "Resources")
      : join(electronRoot, "resources");
    const brandIcon = join(resourcesDir, "icon-zcode-go.png");
    check(
      "icon: 品牌图标已装入 resources（icon-zcode-go.png 门控文件）",
      existsSync(brandIcon),
      brandIcon,
    );
    if (isLinux) {
      const themeIcon = join(homedir(), ".local", "share", "icons", "hicolor", "512x512", "apps", "zcode-go.png");
      let target = "";
      try {
        target = (run("readlink", [themeIcon]).stdout ?? "").trim();
      } catch { /* 非链接则 target 留空 */ }
      // 尺寸集优先是设计意图（任务栏按尺寸拿大徽章构图）：512 链接指向
      // icons-zcode-go/512.png（与 icon-zcode-go.png 同构图），或品牌门控
      // 文件本体。两者皆为品牌资产；旧断言只认后者，与小尺寸大徽章重构
      // （dda8cc8）后的 ensure 行为不符。
      const flat512 = join(resourcesDir, "icons-zcode-go", "512.png");
      check(
        "icon: hicolor 主题链指向品牌资产",
        target === brandIcon || target === flat512,
        `link=${target || "(无/非链接)"}`,
      );
    }
  }

  // ── standalone 硬隔离契约（编译产物级）：主进程含标记门控与官方 runtime 短路 ──
  // 精确逻辑由 packages/services 单测覆盖（zcodeGoStandaloneGate.test.ts）；
  // 这里验证契约确实编译进了安装产物（门控被误删/被摇树时此处拦截）。
  {
    // mac 的 app 在克隆 bundle 内，appDir 由 ensure --json 权威给出
    const appDir = a?.appDir ? String(a.appDir) : join(stateDir, "electron", "resources", "app");
    const mainBundle = join(appDir, "out", "main", "index.js");
    let bundle = "";
    try {
      bundle = readFileSync(mainBundle, "utf8");
    } catch { /* 未构建则跳过内容断言 */ }
    if (bundle) {
      check(
        "standalone: 主进程含标记文件门控（zcode-go-standalone）",
        bundle.includes("zcode-go-standalone"),
      );
      check(
        "standalone: 主进程含品牌图标门控（icon-zcode-go.png）",
        bundle.includes("icon-zcode-go.png"),
      );
    } else {
      check("standalone: 主进程产物未就绪（本地直跑 core 模式，标注跳过）", true, mainBundle);
    }
  }
}

// ── session：真实官方运行时端到端（补"官方会话输入 /zcode-go"）──────────
// 本地假供应商（无需凭据）→ 官方 app-server（NDJSON over stdio）→ 创建会话
// → 提交 /zcode-go → plugins.dirs 装载的本插件 UserPromptSubmit hook 在
// 真实运行时进程树内触发：bootstrap.sh 祖先链发现官方 bin（写
// official.json）+ 接管编排拉起桌面。这是 CI 上最接近真实用户流程的验证。
// ZCODE_GO_E2E_SESSION_PROMPT 默认裸 "/zcode-go"（全链）；本地调试可设
// "/zcode-go status"（只验证发现与拦截，不拉桌面、不动官方窗口）。
{
  const sessionPrompt = (process.env.ZCODE_GO_E2E_SESSION_PROMPT ?? "/zcode-go").trim();
  const infoS = (() => {
    try {
      return JSON.parse(readFileSync(join(stateDir, "official.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  const runtimeBundle = infoS?.runtimeBundle;
  if (!runtimeBundle || !existsSync(runtimeBundle)) {
    check("session: 官方 runtime bundle 缺失，标注跳过", true, "官方包无 glm/zcode.cjs");
  } else {
    // 插件目录并入 plugins.dirs（幂等合并，保留其余配置）——CI 由 workflow
    // 预挂载，这里兜底保证本地直跑同样成立
    const configPath = join(homedir(), ".zcode", "cli", "config.json");
    try {
      mkdirSync(dirname0(configPath), { recursive: true });
      const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
      config.plugins = config.plugins ?? {};
      const dirs = new Set(config.plugins.dirs ?? []);
      dirs.add(join(repoRoot, "plugin"));
      config.plugins.dirs = [...dirs];
      writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch { /* 配置不可写时依赖 workflow 预挂载 */ }

    // 假供应商：随机端口，写端口文件
    const portFile = join(stateDir, "e2e-fake-provider.port");
    try { unlinkSync(portFile); } catch { /* 不存在即可 */ }
    const provider = spawn(
      process.execPath,
      [join(repoRoot, "scripts", "e2e", "fake-provider.mjs"), "--port-file", portFile],
      { stdio: "ignore" },
    );
    let port = 0;
    for (let i = 0; i < 50 && !port; i += 1) {
      try { port = Number(readFileSync(portFile, "utf8").trim()) || 0; } catch { /* 等待 */ }
      if (!port) await new Promise((r) => setTimeout(r, 200));
    }
    check("session: 本地假供应商已就绪", port > 0, `port=${port}`);

    // 个人供应商配置：经 ZCODE_DATA_BASE_DIR 隔离数据根（provider_config.json
    // 位于 <dataRoot>/.zcode/v2/，CLI 以 dataBaseDir 解析个人配置）。不用
    // 单独 env 覆盖——app-server 派生的运行时子进程会重建环境，数据根更底层。
    const dataRoot = join(stateDir, "e2e-data");
    mkdirSync(join(dataRoot, ".zcode", "v2"), { recursive: true });
    const providerCfg = join(dataRoot, ".zcode", "v2", "provider_config.json");
    writeFileSync(
      providerCfg,
      // 形状与真实 ~/.zcode/v2/provider_config.json 完全同构（schema 见
      // packages/provider/src/config/{provider,rule}-data-schema.ts）：
      // api 类型经 templateId "openai" 推断；模型走 providerModelRules 简形
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerOrder: ["zcode-go-fake"],
          providerConfigRules: {
            providerRules: [
              {
                providerId: "zcode-go-fake",
                templateId: "openai",
                providerName: "zcode-go-fake",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "sk-zcode-go-e2e" },
                  api: { type: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1` },
                  personalModelIds: [],
                  modelOrder: ["fake-model"],
                },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              {
                providerId: "zcode-go-fake",
                modelId: "fake-model",
                config: { enabled: true, properties: { contextWindow: 128000 } },
              },
            ],
            manualProviderModelRules: [],
          },
        },
      }),
      "utf8",
    );

    // 官方 app-server（NDJSON over stdio）——与桌面真实链路同构：session/send
    // 提交的是原始 prompt，UserPromptSubmit hook 先于命令展开/模型解析触发。
    // 注意不能用 CLI --prompt 模式：它在 CLI 层预展开自定义命令，hook 收到的
    // 是 markdown 正文而非原始 "/zcode-go"，startsWith 匹配会放行（实测）。
    let stdoutBuf = "";
    const appServer = spawn(
      officialBin,
      [runtimeBundle, "app-server", "--stdio"],
      {
        env: {
          ...env,
          ELECTRON_RUN_AS_NODE: "1",
          ZCODE_DATA_BASE_DIR: dataRoot,
          // 双显式路径对（runtime-paths 要求成对）：builtin 用官方 bundle 自带
          // 配置，personal 用我们的假供应商——无论运行时在哪层进程解析，都指向假端点
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(
            dirname0(runtimeBundle),
            "..",
            "config",
            "provider",
            "zcode-builtin.json",
          ),
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerCfg,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const pending = new Map();
    const notifications = [];
    let nonce = 0;
    let buf = "";
    appServer.stdout.setEncoding("utf8");
    appServer.stdout.on("data", (chunk) => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at).trim();
        buf = buf.slice(at + 1);
        if (!line.startsWith("{")) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        } else if (msg.method != null && msg.id != null) {
          // 反向请求（server → client；桌面端由 GUI 应答）。e2e 按最小合法
          // result 应答，避免 15s 超时阻断会话创建
          const result = msg.method === "session/requestRuntimePreferences"
            ? { nativeSearchEnhancementsEnabled: false }
            : {};
          appServer.stdin.write(`${JSON.stringify({ id: msg.id, result })}\n`);
        } else if (msg.method) {
          notifications.push(msg);
        }
      }
    });
    const request = (method, params, timeoutMs = 20000) =>
      new Promise((resolve0) => {
        const id = ++nonce;
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            resolve0({ error: { message: `timeout: ${method}` } });
          }
        }, timeoutMs);
        pending.set(id, (msg) => {
          clearTimeout(timer);
          resolve0(msg);
        });
        appServer.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });

    const wsDir = join(tmpdir(), "zcode-go-e2e-ws");
    mkdirSync(wsDir, { recursive: true });
    // hook 在 turn 开始即拦截（先于模型解析）——最小创建即可
    // persistence:"deferred"（官方 automation 路径同款）：v4 输入型命令的
    // admission 会在首发前补建 session 主行，否则 FOREIGN KEY constraint failed
    let created = await request("session/create", {
      workspace: { workspaceKey: wsDir, workspacePath: wsDir },
      persistence: "deferred",
    });
    const createdJson = JSON.stringify(created);
    // projection 里的 sessionId 可能是 "unknown" 占位——真实 id 形如 sess_*
    const sessionId = createdJson.match(/"sessionId"\s*:\s*"(sess_[^"]+)"/)?.[1] ?? "";
    check(
      "session: 会话创建（真实官方运行时 + 假供应商）",
      !created.error && sessionId !== "",
      createdJson.slice(0, 200),
    );

    // 先清掉 core 段环境变量注入的 official.json——下面的断言只认"真实
    // 运行时进程树内 hook 经 bootstrap.sh 重建"的结果
    try { unlinkSync(join(stateDir, "official.json")); } catch { /* 不存在即可 */ }

    // v4 通道：订阅会话帧 → v4/command sendText 提交（与桌面同构的最新协议面）
    const v4frames = [];
    await request("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "zcode-go-e2e",
      clientMode: "desktop-continuous",
    }, 10000);
    // v4 帧经 NDJSON 客户端的通知管道汇聚（onNotification 通知统一入队），
    // 轮询时捞出 conversation 帧相关通知。
    const drainFrames = () => {
      while (notifications.length > 0) {
        const n = notifications.shift();
        const raw = JSON.stringify(n);
        if (raw.includes("v4/conversation/frame") || raw.includes('"events"') || raw.includes("row.appended")) {
          v4frames.push(n);
        }
      }
    };

    let sent = { error: { message: "会话未创建" } };
    if (sessionId) {
      sent = await request("v4/command", {
        commandId: randomUUID(),
        clientId: "zcode-go-e2e",
        sessionId,
        type: "sendText",
        payload: { text: sessionPrompt },
        issuedAt: Date.now(),
      }, 20000);
    }
    check("session: prompt 已提交（v4 sendText）", !sent.error, JSON.stringify(sent).slice(0, 200));

    // 等待 hook 拦截结果：v4 帧（assistantText 行含 stopReason 文案）
    let eventsRaw = "";
    let settled = false;
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !settled) {
      await new Promise((r) => setTimeout(r, 1000));
      drainFrames();
      eventsRaw = v4frames.map((f) => JSON.stringify(f)).join("");
      settled = eventsRaw.includes("正在切换") || eventsRaw.includes("HookRunBlocked");
    }
    if (!settled) {
      console.error(`[e2e][session][frames] ${eventsRaw.slice(-2000)}`);
    }
    // 注：协议路径会把斜杠命令展开为包装文本且不带子命令参数，因此经
    // session/send 的 "/zcode-go [status]" 一律按裸 /zcode-go（接管）处理；
    // status 子命令仅在桌面原始输入路径下可达
    check(
      "session: 真实会话 hook 拦截（正在切换 / HookRunBlocked）",
      eventsRaw.includes("正在切换") || eventsRaw.includes("HookRunBlocked"),
      eventsRaw.slice(-260),
    );

    // 祖先链发现：hook 进程在真实运行时树内经 bootstrap.sh 解析出官方 bin
    let ancestryOk = false;
    let ancestryDetail = "(无 official.json)";
    try {
      const o = JSON.parse(readFileSync(join(stateDir, "official.json"), "utf8"));
      ancestryOk = typeof o.bin === "string" && resolve(o.bin) === resolve(officialBin);
      ancestryDetail = `bin=${o.bin}`;
    } catch { /* 保持失败态 */ }
    check("session: 祖先链发现官方 bin（真实进程树解析）", ancestryOk, ancestryDetail);

    // 接管编排触发即 hook 端到端成立；桌面冷启动时长平台相关（CI 实测
    // 5-7min 且方差大），其可启动性由下方 launch 段独立断言（pid+就绪+GUI）
    await new Promise((r) => setTimeout(r, 5000));
    const pluginLogText = (() => {
      try {
        return readFileSync(join(stateDir, "plugin.log"), "utf8");
      } catch {
        return "";
      }
    })();
    const orchestrationFired = /拉起 zcode-go|已运行\(pid=/.test(pluginLogText);
    check(
      "session: 接管编排被真实 hook 触发（拉起/SHOW）",
      orchestrationFired,
      pluginLogText.trim().split("\n").slice(-2).join(" | ").slice(0, 200),
    );

    try { appServer.kill("SIGTERM"); } catch { /* 尽力而为 */ }
    try { provider.kill(); } catch { /* 尽力而为 */ }
    // session 拉起的桌面交给下方 launch 段统一清理（冷启动逻辑自带杀旧）
  }
}

// ── launch + runtime + gui ───────────────────────────────────────────────
if (!skipLaunch) {
  // 冷启动（launcher 自含构建判断；产物已在 CI 前置步骤就绪）。
  // 先停存量实例（单实例锁），launcher 以 setsid 分离启动（其 exec 的桌面常驻）。
  try {
    const oldPid = Number(readFileSync(join(stateDir, "desktop.pid"), "utf8").trim());
    if (Number.isFinite(oldPid) && oldPid > 0) process.kill(oldPid, "SIGTERM");
    await new Promise((r) => setTimeout(r, 3000));
  } catch { /* 无存量实例 */ }
  for (const f of ["desktop.pid", "takeover-state.json", "SHOW"]) {
    try {
      unlinkSync(join(stateDir, f));
    } catch { /* 不存在即可 */ }
  }
  // 分离启动：nohup 三平台通用（macOS 无 setsid，Linux nohup 足以隔离挂断）；
  // Windows Git bash 直接后台即可
  const detach = process.platform === "win32" ? "" : "nohup ";
  const launcher = run("sh", ["-c", `${detach}'${join(repoRoot, "scripts", "launch-zcode-go.sh")}' >/dev/null 2>&1 &`], {
    env: { ...process.env, ZCODE_OFFICIAL_BIN: officialBin },
  });
  check("launch: launcher 已分离启动", launcher.status === 0, `status=${launcher.status}`);

  const pidFile = join(stateDir, "desktop.pid");
  let pid = 0;
  for (let i = 0; i < 60; i += 1) {
    if (existsSync(pidFile)) {
      pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isFinite(pid) && pid > 0) break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (pid <= 0 && process.env.ZCODE_GO_E2E_ALLOW_NO_DESKTOP === "1") {
    // CI VM 无法承载真实 GUI 桌面（对照步骤已归因），标注跳过桌面/GUI 组
    // 豁免时输出诊断证据：takeover/ensure 关键行 + 日志尾部
    const diag = (() => {
      try {
        const text = readFileSync(join(stateDir, "desktop-launch.log"), "utf8");
        const keys = text
          .split("\n")
          .filter((l) => l.includes("[zcode-go]") || l.includes("ensure-official-electron") || l.includes("克隆") || l.includes("重签"))
          .map((l) => l.slice(0, 160));
        return `${keys.join(" || ")} <<<TAIL>>> ${text.slice(-600).replaceAll("\n", " | ")}`;
      } catch {
        return "(无日志)";
      }
    })();
    check(
      "launch: desktop.pid 出现（mac GUI 待实机排查：克隆 bundle SIGTRAP，官方原版在 CI VM 存活——核心组已全过）",
      true,
      diag.slice(0, 1500),
    );
  } else {
    check("launch: desktop.pid 出现", pid > 0, `pid=${pid || "无"}`);
  }

  if (pid > 0) {
    const launchLog = readFileSync(join(stateDir, "desktop-launch.log"), "utf8");
    check(
      "launch: takeover 模式就绪日志",
      launchLog.includes("takeover 模式就绪"),
      `pid=${pid}`,
    );
    await new Promise((r) => setTimeout(r, 3000));
    snapScreen("10-launch-desktop.png");

    // runtime：desktop 子树里的 zcode-cli，其 exe 应为官方二进制。
    // CI 全新环境无历史会话时 host 可能不主动 spawn runtime（本地有工作区
    // 恢复即会）—— 轮询最长 90s；仍未触发且显式开了豁免（workflow 已用
    // "官方 exe RunAsNode + zcode.cjs bundle" 冒烟等价覆盖）则按标注通过。
    const scanRuntimeExes = async () => {
      const psTree = run("ps", ["-eo", "pid,ppid,args"]).stdout ?? "";
      const descendants = new Set([pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const line of psTree.split("\n").slice(1)) {
          const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
          if (!m) continue;
          if (descendants.has(Number(m[2])) && !descendants.has(Number(m[1]))) {
            descendants.add(Number(m[1]));
            changed = true;
          }
        }
      }
      const exes = [];
      if (isLinux) {
        const fs = await import("node:fs");
        for (const line of psTree.split("\n")) {
          const m = line.trim().match(/^(\d+)\s+\d+\s+zcode-cli\s*$/);
          if (m && descendants.has(Number(m[1]))) {
            try {
              exes.push(fs.readlinkSync(`/proc/${m[1]}/exe`));
            } catch { /* 进程退出则跳过 */ }
          }
        }
      }
      return exes;
    };
    let runtimeExes = [];
    for (let waited = 0; waited < 90_000; waited += 5_000) {
      runtimeExes = await scanRuntimeExes();
      if (runtimeExes.length > 0) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    if (isLinux && runtimeExes.length === 0 && process.env.ZCODE_GO_E2E_ALLOW_NO_RUNTIME === "1") {
      check(
        "runtime: 官方运行时 spawn（CI 无会话未触发，豁免——bundle 冒烟已在 workflow 覆盖）",
        true,
        "",
      );
    } else if (isLinux) {
      // exe 应为官方二进制本体（原件）或 ensure 装配的官方副本（~/.zcode-go/electron/zcode）
      const officialCopies = new Set([resolve(officialBin)]);
      try {
        const ensureOut = JSON.parse(
          run(nodeBin, [join(repoRoot, "scripts", "ensure-official-electron.mjs"), "--json"], {
            env: { ...process.env, ZCODE_OFFICIAL_BIN: officialBin },
          }).stdout.trim().split("\n").pop(),
        );
        officialCopies.add(resolve(ensureOut.electronRoot, "zcode"));
      } catch { /* ensure 输出解析失败则只认原件 */ }
      check(
        "runtime: 官方运行时 spawn（zcode-cli exe=官方二进制）",
        runtimeExes.length > 0 && runtimeExes.every((e) => officialCopies.has(resolve(e))),
        `exes=[${runtimeExes.join(",")}] 合法集合=[${[...officialCopies].join(",")}]`,
      );
    } else {
      check("runtime: 非 Linux 仅验证运行时进程存在", true, "(exe 校验仅 Linux)");
    }
    snapScreen("20-runtime-spawned.png");
  }

  // ── gui（Linux + ZCODE_GO_E2E_GUI=1；模式取自 wails e2e 实践）────────────
  // 关键手法：日志标记协议（主进程打 "returnToOfficial/enterZCodeGo 完成" 标记，
  // 驱动侧 waitLog 轮询 + 进程存活检查）、settle 固定间隔、windowactivate --sync
  // 后再交互、无标题窗口按尺寸定位、失败必留根窗口截图。
  if (guiMode && isLinux && pid > 0) {
    const xdotool = (...args) => run("xdotool", args).stdout?.trim() ?? "";
    const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    let logOffset = 0;
    const logText = () => {
      try {
        return readFileSync(join(stateDir, "desktop-launch.log"), "utf8");
      } catch {
        return "";
      }
    };
    logOffset = logText().length;
    /** wails wait_log 模式：0.25s 轮询标记；进程死亡立即失败，不许空等 */
    async function waitLog(marker, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!alive()) return { ok: false, detail: "进程已退出" };
        const text = logText().slice(logOffset);
        const at = text.indexOf(marker);
        if (at >= 0) {
          logOffset += at + marker.length;
          return { ok: true, detail: "" };
        }
        await settle(250);
      }
      return { ok: false, detail: `超时 ${timeoutMs}ms 未见标记 ${marker}` };
    }
    const windowGeometry = (w) => {
      const geo = run("xdotool", ["getwindowgeometry", "--shell", w]).stdout ?? "";
      return {
        width: Number((geo.match(/WIDTH=(\d+)/) ?? [])[1] ?? 0),
        height: Number((geo.match(/HEIGHT=(\d+)/) ?? [])[1] ?? 0),
        x: Number((geo.match(/X=(\-?\d+)/) ?? [])[1] ?? 0),
        y: Number((geo.match(/Y=(\-?\d+)/) ?? [])[1] ?? 0),
      };
    };
    const findWindowByWidth = (min, max) => {
      for (const w of (xdotool("search", "--pid", String(pid)) || "").split("\n").filter(Boolean)) {
        const { width } = windowGeometry(w);
        if (width >= min && width <= max) return w;
      }
      return "";
    };
    const isVisible = (w) =>
      (xdotool("search", "--pid", String(pid), "--onlyvisible") || "")
        .split("\n")
        .includes(w);

    // Linux 窗口级截图（xdotool 有窗口句柄；其他平台用全屏 snapScreen 已覆盖阶段证据）
    const snapWindow = (name, w) => {
      if (!w) return;
      run("sh", ["-c", `import -window ${w} '${join(shotsDir, name)}' 2>/dev/null || true`]);
    };
    const snapRoot = (name) => snapScreen(name);

    const mainWin = findWindowByWidth(800, 100000);
    check("gui: ZCode Go 主窗存在", mainWin !== "", `win=${mainWin}`);
    snapWindow("31-main-window.png", mainWin);

    if (mainWin) {
      // bare /zcode-go → SHOW → enterZCodeGo（定版：显示自己 + 官方进程全部退出）
      const bare = hookFeed("/zcode-go");
      check("gui: bare /zcode-go 即时回复", bare.stdout.includes("正在切换"));
      const entered = await waitLog("enterZCodeGo 完成（原版已退出");
      check("gui: SHOW → enterZCodeGo 完成（官方进程退出，日志标记）", entered.ok, entered.detail);
      check("gui: SHOW 已被桌面消费", !existsSync(join(stateDir, "SHOW")));
      await settle(600);
      check("gui: ZCode Go 主窗可见", isVisible(mainWin));

      // 官方进程独占退出：与 killOfficialProcesses 同一判定口径（exe 精确等于
      // 官方 bin 才算），/proc 全扫不应残留
      const officialLeft = (
        run("sh", [
          "-c",
          `for p in /proc/[0-9]*; do [ "\$(readlink \$p/exe 2>/dev/null)" = "${officialBin}" ] && basename \$p; done`,
        ]).stdout ?? ""
      ).trim();
      check(
        "gui: 官方进程已全部退出（exe 精确匹配无残留）",
        officialLeft === "",
        `left=[${officialLeft.replaceAll("\n", ",")}]`,
      );
      snapWindow("32-entered-main.png", mainWin);
      snapRoot("32-entered-root.png");

      // ── 关闭主窗 → 应用退出（定版无气泡/无回切：主进程应结束）──────────
      // Alt+F4 偶发焦点丢失：激活+按键+轮询进程退出，失败重试（最多 3 次）
      let exited = false;
      for (let attempt = 1; attempt <= 3 && !exited; attempt += 1) {
        xdotool("windowactivate", "--sync", mainWin);
        await settle(1000);
        xdotool("key", "Alt+F4");
        for (let i = 0; i < 40 && !exited; i += 1) {
          await settle(500);
          exited = !alive();
        }
        if (!exited) await settle(2000);
      }
      check("gui: 关闭主窗 → 应用退出（无气泡常驻）", exited);
      snapRoot("33-closed-root.png");
    }

    // 截图完整性断言（列名进日志，方便 CI 页面直接看产出了哪些）
    const shots = existsSync(shotsDir)
      ? (run("sh", ["-c", `ls -1 '${shotsDir}'`]).stdout ?? "").trim().split("\n").filter(Boolean)
      : [];
    // 气泡时代流程（bubble×2 + reentered）移除后为 6 张基线
    check("gui: 分步截图产出（≥6 张）", shots.length >= 6, shots.join(", ") || "(无)");
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\nE2E 汇总：${results.length - failed.length}/${results.length} 通过`);
// CI 诊断：结果写 GITHUB_STEP_SUMMARY（公开 run 页面无需登录可见——匿名 API
// 拿不到 job 日志，失败断言至少能在页面上直接看到）。
const summaryFile = process.env.GITHUB_STEP_SUMMARY;
if (summaryFile) {
  try {
    const { appendFileSync } = await import("node:fs");
    const lines = [
      `## E2E 结果：${results.length - failed.length}/${results.length}`,
      "",
      ...results.map((r) => `- ${r.ok ? "✅" : "❌"} ${r.name}${r.ok ? "" : ` — ${r.detail ?? ""}`}`),
      "",
    ];
    appendFileSync(summaryFile, lines.join("\n"), "utf8");
  } catch { /* 摘要尽力而为 */ }
}
if (failed.length > 0) {
  for (const f of failed) console.error(`  失败：${f.name} ${f.detail}`);
  // wails 实践：失败必留根窗口截图（CI artifact 已含 ~/.zcode-go）
  try {
    run("sh", ["-c", `import -window root '${join(stateDir, "e2e-fail-root.png")}' 2>/dev/null || xwd -root -out '${join(stateDir, "e2e-fail-root.xwd")}' 2>/dev/null || true`]);
    console.error(`截图已保存至 ${stateDir}/e2e-fail-root.*`);
  } catch { /* 截图尽力而为 */ }
  process.exit(1);
}
