/**
 * zcode-go OPC 入站队列对话框（渠道中立 ingest 的审批面）：
 * 逐条「转为工作项」（默认优先级/负责人可调）或「忽略」。消费走独立 IPC
 * （main 删 inbox 文件 + 正规建项路径），不污染 mutation 语义。
 */
import { useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpcStore } from "@/store/opcStore.js";
import type { OpcWorkItemPriority } from "@zcode/shared";

export function OpcInboxDialog({ onClose }: { onClose: () => void }) {
  const { intl } = useZCodeIntl();
  const inbox = useOpcStore((s) => s.inbox);
  const state = useOpcStore((s) => s.state);
  const consumeInbox = useOpcStore((s) => s.consumeInbox);
  const [assigneeId, setAssigneeId] = useState<string>("none");
  // 共享选择器初值 = 本批条目自述 priority 的最高档（urgent 静默降级到
  // medium 会丢发送方的紧急语义；共享选择器仍可覆盖）
  const [priority, setPriority] = useState<OpcWorkItemPriority>(() => {
    const rank = { urgent: 0, high: 1, medium: 2, low: 3 } as const;
    const values = inbox.map((item) => item.priority).filter(Boolean) as Array<
      keyof typeof rank
    >;
    return values.length > 0
      ? values.sort((a, b) => rank[a] - rank[b])[0]!
      : "medium";
  });
  const activeEmployees =
    state?.employees.filter((e) => e.status === "active") ?? [];

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "opc.inbox.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "opc.inbox.description" })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>{intl.formatMessage({ id: "opc.inbox.assignee" })}</Label>
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  {intl.formatMessage({ id: "opc.workitem.unassigned" })}
                </SelectItem>
                {activeEmployees.map((employee) => (
                  <SelectItem key={employee.id} value={employee.id}>
                    {employee.emoji} {employee.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{intl.formatMessage({ id: "opc.workitem.priority" })}</Label>
            <Select
              value={priority}
              onValueChange={(value) =>
                setPriority(value as OpcWorkItemPriority)
              }
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["low", "medium", "high", "urgent"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {intl.formatMessage({ id: `opc.priority.${value}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <ScrollArea className="max-h-72">
          <div className="flex flex-col gap-2">
            {inbox.map((item) => (
              <div
                key={item.fileName}
                className="flex flex-col gap-1.5 rounded-lg border border-card-border bg-card p-2.5"
              >
                <p className="text-ui-sm font-medium text-foreground">
                  {item.title}
                </p>
                {item.detail ? (
                  <p className="line-clamp-2 text-ui-xs text-foreground-subtle">
                    {item.detail}
                  </p>
                ) : null}
                <div className="flex items-center gap-2">
                  <span className="text-ui-xs text-foreground-faint">
                    {item.source ?? "unknown"} ·{" "}
                    {item.receivedAt.slice(0, 16).replace("T", " ")}
                  </span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() =>
                        void consumeInbox(item.fileName, {
                          title: item.title,
                          detail: item.detail,
                          priority,
                          assigneeId: assigneeId === "none" ? null : assigneeId,
                        })
                      }
                    >
                      {intl.formatMessage({ id: "opc.inbox.convert" })}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      className="text-foreground-faint"
                      onClick={() => void consumeInbox(item.fileName, null)}
                    >
                      {intl.formatMessage({ id: "opc.inbox.dismiss" })}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
            {inbox.length === 0 ? (
              <p className="py-4 text-center text-ui-xs text-foreground-faint">
                {intl.formatMessage({ id: "opc.inbox.empty" })}
              </p>
            ) : null}
          </div>
        </ScrollArea>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {intl.formatMessage({ id: "opc.common.close" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
