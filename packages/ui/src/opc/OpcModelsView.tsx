/**
 * zcode-go OPC 模型指纹标签（spec「模型指纹」节）：输入 modelKey → 无界面
 * 会话驱动探测电池（编排器同款执行器）→ 指纹落档 → 基线自比对的 verdict
 * 展示与「确认新指纹」处置。
 */
import { useCallback, useMemo, useState } from "react";
import { Fingerprint } from "lucide-react";
import {
  buildOpcProbeSessionPrompt,
  compareOpcFingerprints,
  OPC_PROBE_CELLS,
  opcAnswerDistribution,
  parseOpcProbeAnswers,
  planOpcProbeSession,
  type OpcFingerprintVerdict,
  type OpcMutation,
  type OpcModelFingerprint,
  type OpcCompanyState,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeTaskService } from "@/hooks/useZCodeTaskService.js";
import { useOpcStore } from "@/store/opcStore.js";
import { logger } from "@/logger.js";

const SAMPLES_PER_CELL = 10;

/** 单格采集（无界面会话；格间串行避免采样互扰）。 */
function verdictBadgeClass(verdict: OpcFingerprintVerdict | undefined): string {
  if (verdict === "mismatch") return "text-red-500";
  if (verdict === "uncertain") return "text-amber-500";
  return "text-emerald-500";
}

export function OpcModelsView({
  state,
  workspaceIdentity,
}: {
  state: OpcCompanyState;
  workspaceIdentity?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const workspacePathFromStore = useOpcStore((s) => s.workspacePath);
  const taskService = useZCodeTaskService(
    workspacePathFromStore ?? undefined,
    undefined,
    workspaceIdentity ?? undefined,
  );
  const apply = useOpcStore((s) => s.apply);
  const [modelKey, setModelKey] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [captureNote, setCaptureNote] = useState<string | null>(null);

  const entries = useMemo(
    () => Object.entries(state.modelFingerprints ?? {}),
    [state.modelFingerprints],
  );

  const handleCapture = useCallback(async () => {
    const key = modelKey.trim();
    if (!key.length || !taskService || capturing) return;
    const workspacePath = useOpcStore.getState().workspacePath;
    if (!workspacePath) return;
    setCapturing(true);
    setCaptureNote(null);
    const bridge = (
      window as unknown as {
        zcode?: {
          zcodeGoOpcReadFingerprintSample?: (payload: {
            workspacePath: string;
            fileName: string;
          }) => Promise<{ ok: boolean; content: string | null }>;
        };
      }
    ).zcode;
    const readSample = bridge?.zcodeGoOpcReadFingerprintSample;
    if (!readSample) {
      setCaptureNote(intl.formatMessage({ id: "opc.models.captureFailed" }));
      setCapturing(false);
      return;
    }
    const sleep = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    try {
      const cells: OpcModelFingerprint["cells"] = {};
      let failedCells = 0;
      // 格间串行（spec「模型指纹」节：避免并发采样互扰）
      for (const cell of OPC_PROBE_CELLS) {
        const cellFile = `${cell.key.replace(/:/g, "-")}.json`;
        const outputPath = `.opc/fingerprint/${cellFile}`;
        const plan = planOpcProbeSession(cell, SAMPLES_PER_CELL);
        const prompt = buildOpcProbeSessionPrompt(plan, outputPath);
        const created = await taskService.createTask({
          workspacePath,
          workspaceIdentity: workspaceIdentity ?? undefined,
          v4Create: true,
          deferPersistenceUntilFirstPrompt: true,
          permissionScope: "session",
        });
        setCaptureNote(
          intl.formatMessage({ id: "opc.models.probing" }, { cell: cell.key }),
        );
        await taskService.sendPrompt({
          taskId: created.taskId,
          traceId: `fingerprint:${cell.key}`,
          content: prompt,
          // 探测会话需 Write（写样本文件到 .opc/fingerprint/）；拒越界执行
          // 通道（shell / node-repl / todo 写）——prompt 契约限定只写该文件
          toolDenylist: [
            "Bash",
            "js",
            "js_reset",
            "js_add_node_module_dir",
            "mcp__node_repl__js",
            "mcp__node_repl__js_reset",
            "mcp__node_repl__js_add_node_module_dir",
            "TodoWrite",
          ],
        });
        // 轮询样本文件（sendPrompt 是异步投递，等待 agent 写盘；120s 熔断）
        let answers: string[] | null = null;
        for (let attempt = 0; attempt < 60 && answers === null; attempt += 1) {
          await sleep(2000);
          const sample = await readSample({
            workspacePath,
            fileName: cellFile,
          });
          if (!sample.ok || !sample.content) continue;
          try {
            const parsed: unknown = JSON.parse(sample.content);
            const list = (parsed as { answers?: unknown }).answers;
            if (
              Array.isArray(list) &&
              list.every((item) => typeof item === "string")
            ) {
              answers = list as string[];
            }
          } catch {
            /* 半写 JSON：继续轮询 */
          }
        }
        if (answers === null || answers.length === 0) {
          failedCells += 1;
          continue;
        }
        cells[cell.key] = opcAnswerDistribution(answers, cell.domain);
      }
      const validTotal = Object.values(cells).reduce(
        (acc, stats) => acc + stats.valid,
        0,
      );
      if (Object.keys(cells).length === 0) {
        setCaptureNote(intl.formatMessage({ id: "opc.models.captureFailed" }));
        return;
      }
      const fingerprint: OpcModelFingerprint = {
        modelKey: key,
        capturedAt: Date.now(),
        cells,
        sessionCount: OPC_PROBE_CELLS.length - failedCells,
        validTotal,
      };
      const outcome = await apply([
        { kind: "fingerprint.capture", fingerprint } as OpcMutation,
      ]);
      setCaptureNote(
        intl.formatMessage(
          {
            id: outcome.ok
              ? "opc.models.captureDone"
              : "opc.models.captureFailed",
          },
          { verdict: outcome.ok ? "" : "" },
        ),
      );
      setModelKey("");
    } catch (error) {
      logger.warn("[zcode-go][opc] 指纹采集失败", error);
      setCaptureNote(intl.formatMessage({ id: "opc.models.captureFailed" }));
    } finally {
      setCapturing(false);
    }
  }, [modelKey, taskService, capturing, intl, workspaceIdentity, apply]);

  const handleAcknowledge = useCallback(
    (key: string) => {
      void apply([
        { kind: "fingerprint.acknowledge", modelKey: key } as OpcMutation,
      ]);
    },
    [apply],
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <p className="text-ui-sm text-foreground-subtle">
        {intl.formatMessage({ id: "opc.models.hint" })}
      </p>
      <div className="flex items-center gap-1.5">
        <Input
          value={modelKey}
          onChange={(event) => setModelKey(event.target.value)}
          placeholder={intl.formatMessage({ id: "opc.models.placeholder" })}
          className="h-8 max-w-80"
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!modelKey.trim() || !taskService || capturing}
          onClick={() => void handleCapture()}
        >
          <Fingerprint className="size-4" />
          {intl.formatMessage({
            id: capturing ? "opc.models.capturing" : "opc.models.capture",
          })}
        </Button>
      </div>
      {captureNote ? (
        <p className="text-ui-xs text-red-500">{captureNote}</p>
      ) : null}
      {entries.length === 0 ? (
        <p className="text-ui-xs text-foreground-faint">
          {intl.formatMessage({ id: "opc.models.empty" })}
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map(([key, entry]) => {
            const unconfirmed =
              entry.lastVerdict !== undefined &&
              entry.lastVerdict !== "match" &&
              entry.acknowledgedAt === undefined;
            return (
              <li
                key={key}
                className="rounded-lg border border-card-border bg-card px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{key}</span>
                  <span
                    className={`text-ui-xs ${verdictBadgeClass(entry.lastVerdict)}`}
                  >
                    {entry.lastVerdict
                      ? intl.formatMessage({
                          id: `opc.models.verdict.${entry.lastVerdict}`,
                        })
                      : intl.formatMessage({ id: "opc.models.baselineOnly" })}
                  </span>
                </div>
                <p className="mt-1 text-ui-xs text-foreground-faint">
                  {intl.formatMessage(
                    { id: "opc.models.times" },
                    {
                      baseline: new Date(entry.baseline.capturedAt)
                        .toISOString()
                        .slice(0, 16)
                        .replace("T", " "),
                      last: new Date(entry.last.capturedAt)
                        .toISOString()
                        .slice(0, 16)
                        .replace("T", " "),
                    },
                  )}
                </p>
                {unconfirmed ? (
                  <div className="mt-2 flex items-center gap-2">
                    <p className="text-ui-xs text-foreground-subtle">
                      {intl.formatMessage({ id: "opc.models.unconfirmed" })}
                    </p>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => handleAcknowledge(key)}
                    >
                      {intl.formatMessage({ id: "opc.models.acknowledge" })}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// compareOpcFingerprints 在 capture mutation 内（reducer）使用；UI 侧留作
// 展示 per-cell 详情的后续扩展。
void compareOpcFingerprints;
