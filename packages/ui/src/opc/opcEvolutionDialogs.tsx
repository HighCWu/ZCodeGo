/**
 * zcode-go OPC 进化类对话框：复盘沉淀（RSI 蒸馏入口）与技能自主升级。
 * 从 opcDialogs 拆出以控制文件行数。
 */
import { useMemo, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpcStore } from "@/store/opcStore.js";
import {
  buildOpcRetroPrompt,
  buildOpcSkillUpgradePrompt,
  extractOpcFencedBlock,
  parseOpcLessonsBlock,
  OPC_SKILL_FENCE,
  type OpcCompanyState,
} from "@zcode/shared";
import { insertOpcPromptWithReceipt } from "./opcComposerBridge.js";
import { logger } from "@/logger.js";

export interface OpcRetroDialogState {
  employeeId: string | null;
}

export interface OpcUpgradeDialogState {
  skillId: string;
}

// ---------------------------------------------------------------------------
// 复盘对话框（RSI 蒸馏入口）
// ---------------------------------------------------------------------------

export function OpcRetroDialog({
  state,
  initialEmployeeId,
  onClose,
  workspaceIdentity,
}: {
  state: OpcCompanyState;
  initialEmployeeId: string | null;
  onClose: () => void;
  workspaceIdentity?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const [injectWarning, setInjectWarning] = useState<string | null>(null);
  const apply = useOpcStore((s) => s.apply);
  const workspacePath = useOpcStore((s) => s.workspacePath);
  const [employeeId, setEmployeeId] = useState(
    initialEmployeeId ?? state.employees[0]?.id ?? "",
  );
  const [workItemId, setWorkItemId] = useState<string>("none");
  const [rawOutput, setRawOutput] = useState("");
  const parsedLessons = useMemo(() => {
    const fenced = extractOpcFencedBlock(rawOutput, "opc-lessons");
    if (!fenced) return parseOpcLessonsBlock(rawOutput);
    return parseOpcLessonsBlock(`\`\`\`opc-lessons\n${fenced}\n\`\`\``);
  }, [rawOutput]);
  const employee =
    state.employees.find((item) => item.id === employeeId) ?? null;
  const workItem =
    state.workItems.find((item) => item.id === workItemId) ?? null;

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "opc.retro.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "opc.retro.description" })}
          </DialogDescription>
        </DialogHeader>
        {injectWarning ? (
          <p className="text-ui-xs text-red-500">{injectWarning}</p>
        ) : null}
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "opc.retro.employee" })}</Label>
              <Select value={employeeId} onValueChange={setEmployeeId}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {state.employees
                    .filter((item) => item.status !== "departed")
                    .map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.emoji} {item.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "opc.retro.workItem" })}</Label>
              <Select value={workItemId} onValueChange={setWorkItemId}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {intl.formatMessage({ id: "opc.retro.noWorkItem" })}
                  </SelectItem>
                  {state.workItems
                    .filter((item) => item.status !== "cancelled")
                    .slice(-20)
                    .map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.title}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-retro-output">
              {intl.formatMessage({ id: "opc.retro.outputLabel" })}
            </Label>
            <Textarea
              id="opc-retro-output"
              value={rawOutput}
              onChange={(event) => setRawOutput(event.target.value)}
              rows={6}
              placeholder={intl.formatMessage({
                id: "opc.retro.outputPlaceholder",
              })}
            />
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={!employee || !workspacePath}
                onClick={async () => {
                  if (!employee || !workspacePath) return;
                  const inserted = await insertOpcPromptWithReceipt({
                    workspacePath,
                    workspaceIdentity: workspaceIdentity ?? undefined,
                    text: buildOpcRetroPrompt({
                      employeeName: employee.name,
                      workItemTitle: workItem?.title ?? null,
                    }),
                  });
                  if (inserted) {
                    // 注入即关闭：prompt 已进 composer，模态遮挡反而让用户找不到
                    onClose();
                  } else {
                    setInjectWarning(
                      intl.formatMessage({ id: "opc.injectFailed" }),
                    );
                  }
                }}
              >
                {intl.formatMessage({ id: "opc.retro.generatePrompt" })}
              </Button>
              <span className="text-ui-xs text-foreground-faint">
                {intl.formatMessage(
                  { id: "opc.retro.parsedCount" },
                  { count: parsedLessons.length },
                )}
              </span>
            </div>
          </div>
          {parsedLessons.length > 0 ? (
            <ScrollArea className="max-h-32 rounded-lg border border-card-border bg-surface p-2">
              <ul className="space-y-1">
                {parsedLessons.map((lesson) => (
                  <li
                    key={lesson.statement}
                    className="text-ui-xs text-foreground-subtle"
                  >
                    · {lesson.statement}
                    {lesson.tags.length > 0
                      ? ` [${lesson.tags.join(", ")}]`
                      : ""}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {intl.formatMessage({ id: "opc.common.cancel" })}
          </Button>
          <Button
            size="sm"
            disabled={!employee || parsedLessons.length === 0}
            onClick={async () => {
              if (!employee) return;
              void apply([
                {
                  kind: "retro.record",
                  employeeId: employee.id,
                  workItemId: workItemId === "none" ? null : workItemId,
                  lessons: parsedLessons,
                },
              ]);
              onClose();
            }}
          >
            {intl.formatMessage({ id: "opc.retro.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 技能升级对话框（自主迭代：注入升级 prompt → 回填新正文）
// ---------------------------------------------------------------------------

export function OpcUpgradeDialog({
  state,
  skillId,
  onClose,
  workspaceIdentity,
}: {
  state: OpcCompanyState;
  skillId: string;
  onClose: () => void;
  workspaceIdentity?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const [injectWarning, setInjectWarning] = useState<string | null>(null);
  const apply = useOpcStore((s) => s.apply);
  const resolveSkillBody = useOpcStore((s) => s.resolveSkillBody);
  const workspacePath = useOpcStore((s) => s.workspacePath);
  const skill = state.skills.find((item) => item.id === skillId) ?? null;
  const [goal, setGoal] = useState("");
  const [newBody, setNewBody] = useState("");
  const parsedBody = useMemo(() => {
    if (!newBody.trim()) return null;
    const fenced = extractOpcFencedBlock(newBody, OPC_SKILL_FENCE);
    return (fenced ?? newBody).trim() || null;
  }, [newBody]);

  if (!skill) return null;
  const currentBody = resolveSkillBody(skillId) ?? skill.description;

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "opc.upgrade.title" })} · {skill.name} (v
            {skill.version})
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "opc.upgrade.description" })}
          </DialogDescription>
        </DialogHeader>
        {injectWarning ? (
          <p className="text-ui-xs text-red-500">{injectWarning}</p>
        ) : null}
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-upgrade-goal">
              {intl.formatMessage({ id: "opc.upgrade.goal" })}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="opc-upgrade-goal"
                value={goal}
                onChange={(event) => setGoal(event.target.value)}
                placeholder={intl.formatMessage({
                  id: "opc.upgrade.goalPlaceholder",
                })}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!workspacePath}
                onClick={async () => {
                  if (!workspacePath) return;
                  const inserted = await insertOpcPromptWithReceipt({
                    workspacePath,
                    workspaceIdentity: workspaceIdentity ?? undefined,
                    text: buildOpcSkillUpgradePrompt({
                      skillName: skill.name,
                      currentBody,
                      goal: goal.trim() || undefined,
                    }),
                  });
                  logger.debug("[zcode-go][opc] 升级 prompt 已注入 composer", {
                    skillId,
                  });
                  if (inserted) {
                    // 注入即关闭：prompt 已进 composer，模态遮挡反而让用户找不到
                    onClose();
                  } else {
                    setInjectWarning(
                      intl.formatMessage({ id: "opc.injectFailed" }),
                    );
                  }
                }}
              >
                <Copy className="size-3.5" />
                {intl.formatMessage({ id: "opc.upgrade.generatePrompt" })}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-upgrade-body">
              {intl.formatMessage({ id: "opc.upgrade.newBody" })}
            </Label>
            <Textarea
              id="opc-upgrade-body"
              value={newBody}
              onChange={(event) => setNewBody(event.target.value)}
              rows={8}
              placeholder={intl.formatMessage({
                id: "opc.upgrade.newBodyPlaceholder",
              })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {intl.formatMessage({ id: "opc.common.cancel" })}
          </Button>
          <Button
            size="sm"
            disabled={!parsedBody}
            onClick={async () => {
              if (!parsedBody) return;
              void apply([
                {
                  kind: "skill.upgrade",
                  skillId,
                  body: parsedBody,
                  note: goal.trim() || undefined,
                },
              ]);
              onClose();
            }}
          >
            {intl.formatMessage({ id: "opc.upgrade.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
