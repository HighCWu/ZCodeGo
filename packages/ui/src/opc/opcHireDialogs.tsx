/* oxlint-disable eslint(max-lines) -- 模板入职 + 自定义招聘 + 复用建议三类表单收口（复用建议扩展后超行，拆散会破坏表单内聚）。 */
/**
 * zcode-go OPC 招聘对话框：模板入职（内置/导入共用）与自定义招聘。
 * 从 opcDialogs 拆出以控制文件行数。
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
  type OpcCustomEmployeeDraft,
  type OpcMutation,
  type OpcRoleTemplateDraft,
} from "@zcode/shared";

// ---------------------------------------------------------------------------
// 模板招聘对话框（内置/导入模板共用；确认姓名与资历）
// ---------------------------------------------------------------------------

export interface OpcHireDialogState {
  template: OpcRoleTemplateDraft;
  origin: "builtin" | "imported" | "custom";
}

export function OpcHireDialog({
  state,
  template,
  onClose,
  onSubmit,
}: {
  state: OpcCompanyState;
  template: OpcRoleTemplateDraft;
  onClose: () => void;
  onSubmit: (mutations: OpcMutation[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState(template.name);
  const [seniority, setSeniority] =
    useState<OpcCustomEmployeeDraft["seniority"]>("senior");
  const [permissionLevel, setPermissionLevel] =
    useState<OpcCustomEmployeeDraft["permissionLevel"]>("workspace-write");
  const emptySlots = state.roleSlots.filter((slot) => slot.employeeId === null);
  // 复用建议（Self-Built）：同模板的暂停/离职员工可恢复上岗而非重复招聘
  const reusable = state.employees.find(
    (employee) =>
      employee.templateId === template.id &&
      employee.status !== "active" &&
      !employee.isFallback,
  );
  const [roleId, setRoleId] = useState<string>(emptySlots[0]?.id ?? "none");

  const draft: OpcCustomEmployeeDraft = {
    name: name.trim() || template.name,
    category: template.category,
    emoji: template.emoji,
    color: template.color,
    vibe: template.vibe,
    description: template.description,
    seniority,
    permissionLevel,
  };

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {template.emoji} {intl.formatMessage({ id: "opc.hire.title" })}
          </DialogTitle>
          <DialogDescription>{template.description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-hire-name">
              {intl.formatMessage({ id: "opc.hire.name" })}
            </Label>
            <Input
              id="opc-hire-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "opc.hire.seniority" })}</Label>
              <Select
                value={seniority}
                onValueChange={(value) =>
                  setSeniority(value as OpcCustomEmployeeDraft["seniority"])
                }
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["junior", "senior", "lead"] as const).map((value) => (
                    <SelectItem key={value} value={value}>
                      {intl.formatMessage({ id: `opc.seniority.${value}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "opc.hire.permission" })}</Label>
              <Select
                value={permissionLevel ?? "workspace-write"}
                onValueChange={(value) =>
                  setPermissionLevel(
                    value as NonNullable<
                      OpcCustomEmployeeDraft["permissionLevel"]
                    >,
                  )
                }
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    ["read-only", "workspace-write", "full-access"] as const
                  ).map((value) => (
                    <SelectItem key={value} value={value}>
                      {intl.formatMessage({ id: `opc.permission.${value}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "opc.hire.roleSlot" })}</Label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {intl.formatMessage({ id: "opc.hire.noSlot" })}
                  </SelectItem>
                  {state.roleSlots.map((slot) => (
                    <SelectItem
                      key={slot.id}
                      value={slot.id}
                      disabled={slot.employeeId !== null}
                    >
                      {slot.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        {reusable ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-ui-xs">
            <p className="text-foreground-subtle">
              {intl.formatMessage(
                { id: "opc.hire.reuseHint" },
                {
                  name: reusable.name,
                  status: intl.formatMessage({
                    id:
                      reusable.status === "paused"
                        ? "opc.employee.statusPaused"
                        : "opc.employee.statusDeparted",
                  }),
                },
              )}
            </p>
            <Button
              size="xs"
              variant="secondary"
              className="mt-1.5"
              onClick={() => {
                onSubmit([
                  {
                    kind: "employee.update",
                    employeeId: reusable.id,
                    patch: {
                      status: "active",
                      name: draft.name,
                      seniority: draft.seniority,
                      roleId: roleId === "none" ? null : roleId,
                      // 表单里选的权限级别不丢（员工权限边界随复用更新）
                      permissionLevel: draft.permissionLevel,
                    },
                  },
                ]);
                onClose();
              }}
            >
              {intl.formatMessage(
                { id: "opc.hire.reuse" },
                { name: reusable.name },
              )}
            </Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {intl.formatMessage({ id: "opc.common.cancel" })}
          </Button>
          <Button
            size="sm"
            onClick={() =>
              onSubmit([
                {
                  kind: "employee.hire",
                  templateId: template.id,
                  roleId: roleId === "none" ? null : roleId,
                  custom: draft,
                },
              ])
            }
          >
            {intl.formatMessage({ id: "opc.hire.confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// 自定义招聘对话框
// ---------------------------------------------------------------------------

export function OpcCustomHireDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (mutations: OpcMutation[]) => void;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("general");
  const [emoji, setEmoji] = useState("🧑‍💼");
  const [vibe, setVibe] = useState("");
  const [description, setDescription] = useState("");
  const [seniority, setSeniority] =
    useState<OpcCustomEmployeeDraft["seniority"]>("junior");
  const [permissionLevel, setPermissionLevel] =
    useState<OpcCustomEmployeeDraft["permissionLevel"]>("workspace-write");

  return (
    <Dialog open onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "opc.hire.customTitle" })}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-[1fr_5rem] gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="opc-chire-name">
                {intl.formatMessage({ id: "opc.hire.name" })}
              </Label>
              <Input
                id="opc-chire-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="opc-chire-emoji">Emoji</Label>
              <Input
                id="opc-chire-emoji"
                value={emoji}
                onChange={(event) => setEmoji(event.target.value)}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "opc.hire.category" })}</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[
                    "general",
                    "engineering",
                    "design",
                    "product",
                    "research",
                    "finance",
                    "sales",
                    "marketing",
                    "media",
                    "operations",
                    "education",
                    "executive",
                  ].map((value) => (
                    <SelectItem key={value} value={value}>
                      {intl.formatMessage({ id: `opc.category.${value}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{intl.formatMessage({ id: "opc.hire.permission" })}</Label>
              <Select
                value={permissionLevel ?? "workspace-write"}
                onValueChange={(value) =>
                  setPermissionLevel(
                    value as NonNullable<
                      OpcCustomEmployeeDraft["permissionLevel"]
                    >,
                  )
                }
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(
                    ["read-only", "workspace-write", "full-access"] as const
                  ).map((value) => (
                    <SelectItem key={value} value={value}>
                      {intl.formatMessage({ id: `opc.permission.${value}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{intl.formatMessage({ id: "opc.hire.seniority" })}</Label>
            <Select
              value={seniority}
              onValueChange={(value) =>
                setSeniority(value as OpcCustomEmployeeDraft["seniority"])
              }
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["junior", "senior", "lead"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {intl.formatMessage({ id: `opc.seniority.${value}` })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-chire-vibe">
              {intl.formatMessage({ id: "opc.hire.vibe" })}
            </Label>
            <Input
              id="opc-chire-vibe"
              value={vibe}
              onChange={(event) => setVibe(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="opc-chire-desc">
              {intl.formatMessage({ id: "opc.hire.description" })}
            </Label>
            <Textarea
              id="opc-chire-desc"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>
            {intl.formatMessage({ id: "opc.common.cancel" })}
          </Button>
          <Button
            size="sm"
            disabled={!name.trim()}
            onClick={() =>
              onSubmit([
                {
                  kind: "employee.hire",
                  templateId: "custom",
                  roleId: null,
                  custom: {
                    name: name.trim(),
                    category,
                    emoji: emoji.trim() || "🧑‍💼",
                    color: "slate",
                    vibe: vibe.trim(),
                    description: description.trim(),
                    seniority,
                    permissionLevel,
                  },
                },
              ])
            }
          >
            {intl.formatMessage({ id: "opc.hire.confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
