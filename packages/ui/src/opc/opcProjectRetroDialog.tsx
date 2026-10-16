/**
 * zcode-go OPC 项目级复盘对话框（OpenOPC「项目复盘」粒度）：
 * 生成全员复盘 prompt（列出在职员工与近期工作项），agent 输出的 opc-lessons
 * 带 employee 归属；解析后按员工分组预览，一键逐人 retro.record 落账
 * （归属不明的记到创始人——所有者是公司级流程经验的天然归属）。
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Label } from "@/components/ui/label.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpcStore } from "@/store/opcStore.js";
import {
  buildOpcProjectRetroPrompt,
  parseOpcLessonsBlock,
  type OpcMutation,
  type OpcParsedLesson,
} from "@zcode/shared";
import { insertOpcPrompt } from "./opcComposerBridge.js";

export function OpcProjectRetroDialog({
  onClose,
  workspaceIdentity,
}: {
  onClose: () => void;
  workspaceIdentity?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const apply = useOpcStore((s) => s.apply);
  const state = useOpcStore((s) => s.state);
  const workspacePath = useOpcStore((s) => s.workspacePath);
  const [goal, setGoal] = useState("");
  const [output, setOutput] = useState("");

  const parsed = useMemo(() => {
    if (!state) return null;
    const lessons = parseOpcLessonsBlock(output);
    if (lessons.length === 0) return null;
    // 按员工名归属（不明确/未命中的记到创始人）
    const founder = state.employees.find((employee) => employee.isFallback);
    const groups = new Map<string, Array<OpcParsedLesson>>();
    for (const lesson of lessons) {
      const target =
        state.employees.find(
          (employee) =>
            employee.status !== "departed" &&
            (lesson.employee === employee.name ||
              lesson.employee?.toLowerCase() === employee.id),
        )?.id ?? founder?.id;
      if (!target) continue;
      const bucket = groups.get(target) ?? [];
      bucket.push(lesson);
      groups.set(target, bucket);
    }
    return { groups, founder };
  }, [output, state]);

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "opc.projectRetro.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "opc.projectRetro.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-projretro-goal">
              {intl.formatMessage({ id: "opc.projectRetro.goalLabel" })}
            </Label>
            <Textarea
              id="opc-projretro-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={2}
              placeholder={intl.formatMessage({
                id: "opc.projectRetro.goalPlaceholder",
              })}
            />
            <Button
              size="xs"
              variant="outline"
              className="self-start"
              disabled={!state || !workspacePath}
              onClick={() => {
                if (!state || !workspacePath) return;
                insertOpcPrompt({
                  workspacePath,
                  workspaceIdentity: workspaceIdentity ?? undefined,
                  text: buildOpcProjectRetroPrompt({
                    companyName: state.company.name,
                    employees: state.employees
                      .filter((employee) => employee.status !== "departed")
                      .map((employee) => ({
                        name: employee.name,
                        category: employee.category,
                      })),
                    recentWorkItems: state.workItems
                      .filter((item) => item.status !== "cancelled")
                      .slice(-12)
                      .map((item) => ({
                        title: item.title,
                        status: item.status,
                      })),
                  }),
                });
                // 注入即关闭：prompt 已进 composer，模态遮挡反而让用户找不到
                onClose();
              }}
            >
              {intl.formatMessage({ id: "opc.projectRetro.generatePrompt" })}
            </Button>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-projretro-output">
              {intl.formatMessage({ id: "opc.projectRetro.outputLabel" })}
            </Label>
            <Textarea
              id="opc-projretro-output"
              value={output}
              onChange={(event) => setOutput(event.target.value)}
              rows={6}
              placeholder={intl.formatMessage({
                id: "opc.projectRetro.outputPlaceholder",
              })}
            />
          </div>
          {parsed && parsed.groups.size > 0 ? (
            <ScrollArea className="max-h-40">
              <div className="flex flex-col gap-2">
                {[...parsed.groups.entries()].map(([employeeId, lessons]) => {
                  const employee = state?.employees.find(
                    (item) => item.id === employeeId,
                  );
                  return (
                    <div
                      key={employeeId}
                      className="rounded-lg border border-card-border bg-surface p-2"
                    >
                      <p className="text-ui-xs font-medium text-foreground">
                        {employee
                          ? `${employee.emoji} ${employee.name}`
                          : employeeId}
                      </p>
                      <ul className="mt-0.5 space-y-0.5">
                        {lessons.map((lesson) => (
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
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {intl.formatMessage({ id: "opc.common.cancel" })}
          </Button>
          <Button
            size="sm"
            disabled={!parsed || parsed.groups.size === 0}
            onClick={() => {
              if (!parsed) return;
              const mutations: OpcMutation[] = [...parsed.groups.entries()].map(
                ([employeeId, lessons]) => ({
                  kind: "retro.record" as const,
                  employeeId,
                  workItemId: null,
                  lessons: lessons.map((lesson) => ({
                    statement: lesson.statement,
                    tags: lesson.tags,
                  })),
                }),
              );
              void apply(mutations);
              onClose();
            }}
          >
            {intl.formatMessage({ id: "opc.projectRetro.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
