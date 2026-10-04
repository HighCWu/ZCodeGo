/**
 * zcode-go 观察者共用的 v4 wire 帧逻辑载荷提取器。
 *
 * zcodeAgentService 的帧分发点（conversationFrame 通知）把 **wire 层候选**
 * （topicWireFrameCandidateSchema 校验产物）交给观察函数，其形态是：
 *
 *   { wireVersion, kind: "complete", topic, subscriptionId, logicalFrameId,
 *     logicalFrameOrdinal, frame: <逻辑帧> }
 *   { wireVersion, kind: "fragment", topic, logicalFrameId, fragmentIndex,
 *     fragmentCount, logicalBytes, checksum, dataBase64 }   ← 大帧分片，无 frame 键
 *
 * 逻辑帧（{ topic, payload: { kind: "snapshot"|"deltas", snapshot|deltas } }）在
 * complete 帧的 frame 键里；超大逻辑帧（大会话快照等）全部以 fragment 分片到达，
 * 必须按 logicalFrameId 重组后才能 JSON.parse。各 zcode-go 观察模块早期直接按
 * 逻辑帧结构读 wire 顶层（wire.payload 永远是 undefined），全部静默失效——这是
 * 四个看门狗模块零日志、零动作的根因，本模块统一收口。
 *
 * 重组缓冲有界（条目数 + 年龄双淘汰），重复分片幂等，乱序到达按 index 归位。
 */
export interface LogicalFramePayload {
  kind: "snapshot" | "deltas";
  snapshot?: unknown;
  deltas?: unknown[];
}

interface ReassemblyEntry {
  parts: Map<number, Buffer>;
  count: number;
  decodedBytes: number;
  firstAt: number;
}

const MAX_PENDING_FRAMES = 128;
const PENDING_ENTRY_TTL_MS = 60_000;
const pendingFrames = new Map<string, ReassemblyEntry>();

/**
 * 从 wire 层帧提取逻辑帧 payload。complete 直接取；fragment 重组（未集齐返回
 * null——本帧继续等待后续分片，集齐的那一片返回整帧结果）。非帧形态/解析失败
 * 一律 null，调用方静默跳过。
 */
export function extractLogicalFramePayload(wire: unknown): LogicalFramePayload | null {
  if (typeof wire !== "object" || wire === null) return null;
  const w = wire as {
    kind?: unknown;
    frame?: unknown;
    logicalFrameId?: unknown;
    fragmentIndex?: unknown;
    fragmentCount?: unknown;
    dataBase64?: unknown;
  };
  let logical: unknown;
  if (w.kind === "complete") {
    logical = w.frame;
  } else if (w.kind === "fragment") {
    logical = reassembleFragment(w);
  } else {
    return null;
  }
  if (typeof logical !== "object" || logical === null) return null;
  const payload = (logical as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as { kind?: unknown; snapshot?: unknown; deltas?: unknown };
  if (p.kind === "snapshot") return { kind: "snapshot", snapshot: p.snapshot };
  if (p.kind === "deltas" && Array.isArray(p.deltas)) return { kind: "deltas", deltas: p.deltas };
  return null;
}

/** wire 帧的 topic（complete/fragment 均携带）；非帧形态返回 undefined。 */
export function wireFrameTopic(wire: unknown): string | undefined {
  if (typeof wire !== "object" || wire === null) return undefined;
  const topic = (wire as { topic?: unknown }).topic;
  return typeof topic === "string" && topic.length > 0 ? topic : undefined;
}

function reassembleFragment(w: {
  logicalFrameId?: unknown;
  fragmentIndex?: unknown;
  fragmentCount?: unknown;
  dataBase64?: unknown;
}): unknown | null {
  const id = w.logicalFrameId;
  const index = w.fragmentIndex;
  const count = w.fragmentCount;
  const dataBase64 = w.dataBase64;
  if (typeof id !== "string" || !id) return null;
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || index >= count) return null;
  if (typeof dataBase64 !== "string" || !dataBase64) return null;

  evictStale();

  // 每片独立 base64（官方编码按原始字节切片、片内编码，片间可有 padding），
  // 必须先解码再按 index 拼接字节——base64 字符串直接拼接会因 padding 错位损坏。
  let decoded: Buffer;
  try {
    decoded = Buffer.from(dataBase64, "base64");
  } catch {
    return null;
  }
  if (decoded.byteLength === 0) return null;

  let entry = pendingFrames.get(id);
  if (!entry || entry.count !== count) {
    entry = { parts: new Map(), count, decodedBytes: 0, firstAt: Date.now() };
    pendingFrames.set(id, entry);
  }
  if (!entry.parts.has(index)) {
    entry.parts.set(index, decoded);
    entry.decodedBytes += decoded.byteLength;
  }
  if (entry.parts.size < count) return null;

  pendingFrames.delete(id);
  const ordered: Buffer[] = [];
  for (let i = 0; i < count; i += 1) {
    const part = entry.parts.get(i);
    if (part === undefined) return null;
    ordered.push(part);
  }
  const logical = Buffer.concat(ordered);
  try {
    return JSON.parse(logical.toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

function evictStale(): void {
  const now = Date.now();
  for (const [id, entry] of pendingFrames) {
    if (now - entry.firstAt > PENDING_ENTRY_TTL_MS) pendingFrames.delete(id);
  }
  // 年龄淘汰后仍超界则丢最旧（Map 迭代序 = 插入序）。
  while (pendingFrames.size >= MAX_PENDING_FRAMES) {
    const oldest = pendingFrames.keys().next();
    if (oldest.done) break;
    pendingFrames.delete(oldest.value);
  }
}
