/**
 * zcode-go OPC 面板对话框集：工作项编辑、模板/自定义招聘、复盘、技能升级。
 * 从 ZcodeGoOpcPanelRoot 拆出以控制文件行数；全部写路径经 apply(mutations) 收口。
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
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  type OpcCompanyState,
  type OpcMutation,
  type OpcRoleTemplateDraft,
  type OpcWorkItem,
  type OpcWorkItemPriority,
  recommendOpcAssignees,
} from "@zcode/shared";

export interface OpcWorkItemDialogState {
  mode: "create" | "edit";
  workItem: OpcWorkItem | null;
}

export interface OpcHireDialogState {
  template: OpcRoleTemplateDraft;
  origin: "builtin" | "imported" | "custom";
}

// ---------------------------------------------------------------------------
// 工作项新建/编辑对话框
// ---------------------------------------------------------------------------

export function OpcWorkItemDialog({
  state,
  initial,
  onClose,
  onSubmit,
}: {
  state: OpcCompanyState;
  initial: OpcWorkItemDialogState;
  onClose: () => void;
  onSubmit: (mutations: OpcMutation[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const editing = initial.workItem;
  const [title, setTitle] = useState(editing?.title ?? "");
  const [detail, setDetail] = useState(editing?.detail ?? "");
  const [assigneeId, setAssigneeId] = useState<string>(
    editing?.assigneeId ?? "none",
  );
  const [priority, setPriority] = useState<OpcWorkItemPriority>(
    editing?.priority ?? "medium",
  );
  const [dependsOn, setDependsOn] = useState<string[]>(
    editing?.dependsOn ?? [],
  );
  const activeEmployees = state.employees.filter(
    (employee) => employee.status === "active",
  );
  const dependencyCandidates = state.workItems.filter(
    (item) => item.id !== editing?.id,
  );

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id: editing
                ? "opc.workitem.editTitle"
                : "opc.workitem.createTitle",
            })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-wi-title">
              {intl.formatMessage({ id: "opc.workitem.title" })}
            </Label>
            <Input
              id="opc-wi-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-wi-detail">
              {intl.formatMessage({ id: "opc.workitem.detail" })}
            </Label>
            <Textarea
              id="opc-wi-detail"
              value={detail}
              onChange={(event) => setDetail(event.target.value)}
              rows={4}
              placeholder={intl.formatMessage({
                id: "opc.workitem.detailPlaceholder",
              })}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label>
                  {intl.formatMessage({ id: "opc.workitem.assignee" })}
                </Label>
                <button
                  type="button"
                  className="text-ui-xs text-foreground-subtle underline underline-offset-2"
                  onClick={() => {
                    const top = recommendOpcAssignees(
                      state,
                      {
                        dependsOn,
                        assigneeId: assigneeId === "none" ? null : assigneeId,
                      },
                      1,
                    )[0];
                    if (top) setAssigneeId(top.employeeId);
                  }}
                >
                  {intl.formatMessage({ id: "opc.workitem.recommend" })}
                </button>
              </div>
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
              <Label>
                {intl.formatMessage({ id: "opc.workitem.priority" })}
              </Label>
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
                  {(["low", "medium", "high", "urgent"] as const).map(
                    (value) => (
                      <SelectItem key={value} value={value}>
                        {intl.formatMessage({ id: `opc.priority.${value}` })}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          {dependencyCandidates.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "opc.workitem.deps" })}</Label>
              <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-card-border bg-surface p-2">
                {dependencyCandidates.map((candidate) => {
                  const selected = dependsOn.includes(candidate.id);
                  return (
                    <Button
                      key={candidate.id}
                      size="xs"
                      variant={selected ? "secondary" : "ghost"}
                      onClick={() =>
                        setDependsOn((current) =>
                          selected
                            ? current.filter((id) => id !== candidate.id)
                            : [...current, candidate.id],
                        )
                      }
                      title={candidate.title}
                    >
                      {selected ? "✓ " : ""}
                      <span className="max-w-40 truncate">
                        {candidate.title}
                      </span>
                    </Button>
                  );
                })}
              </div>
              <p className="text-ui-xs text-foreground-faint">
                {intl.formatMessage({ id: "opc.workitem.depsHint" })}
              </p>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {intl.formatMessage({ id: "opc.common.cancel" })}
          </Button>
          <Button
            size="sm"
            disabled={!title.trim()}
            onClick={() => {
              const patchAssignee = assigneeId === "none" ? null : assigneeId;
              if (editing) {
                onSubmit([
                  {
                    kind: "workitem.update",
                    workItemId: editing.id,
                    patch: {
                      title: title.trim(),
                      detail,
                      assigneeId: patchAssignee,
                      priority,
                      dependsOn,
                    },
                  },
                ]);
              } else {
                onSubmit([
                  {
                    kind: "workitem.create",
                    title: title.trim(),
                    detail,
                    assigneeId: patchAssignee,
                    priority,
                    dependsOn,
                  },
                ]);
              }
            }}
          >
            {intl.formatMessage({ id: "opc.common.save" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 返工退回对话框（review → in_progress + 返工意见）
// ---------------------------------------------------------------------------

export function OpcReworkDialog({
  workItem,
  onClose,
  onSubmit,
}: {
  workItem: OpcWorkItem;
  onClose: () => void;
  onSubmit: (mutations: OpcMutation[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const [note, setNote] = useState("");
  const existing = workItem.reworkNotes ?? [];

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "opc.rework.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "opc.rework.description" })}
          </DialogDescription>
        </DialogHeader>
        {existing.length > 0 ? (
          <div className="rounded-lg border border-card-border bg-surface p-2">
            <p className="mb-1 text-ui-xs text-foreground-faint">
              {intl.formatMessage({ id: "opc.rework.existing" })}
            </p>
            <ul className="space-y-0.5">
              {existing.map((item) => (
                <li key={item} className="text-ui-xs text-foreground-subtle">
                  · {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={4}
          placeholder={intl.formatMessage({ id: "opc.rework.notePlaceholder" })}
          autoFocus
        />
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {intl.formatMessage({ id: "opc.common.cancel" })}
          </Button>
          <Button
            size="sm"
            disabled={!note.trim()}
            onClick={() => {
              onSubmit([
                {
                  kind: "workitem.rework",
                  workItemId: workItem.id,
                  note: note.trim(),
                },
              ]);
              onClose();
            }}
          >
            {intl.formatMessage({ id: "opc.rework.submit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
