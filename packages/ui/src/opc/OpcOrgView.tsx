/* oxlint-disable eslint(max-lines) -- zcode-go OPC 组织视图：员工卡片（内联模型偏好编辑、画像重置两段确认）与岗位槽位/招聘/导入导出收口在单文件，拆散会更难追踪（同 SessionPane 惯例）。 */
/**
 * zcode-go OPC 组织视图：岗位槽位 + 员工卡片（复盘/暂停/离职/挂接技能）。
 */
import { useMemo, useState } from "react";
import { Plus, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { ScrollArea } from "@/components/ui/scroll-area.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpcCompanyState, OpcEmployee } from "@zcode/shared";
import { OpcEmployeeAvatar } from "./opcDisplay.js";

export interface OpcOrgViewProps {
  state: OpcCompanyState;
  onAddRoleSlot: (title: string) => void;
  onHire: () => void;
  onOpenGenerate: () => void;
  onOpenPresets: () => void;
  onExportCompany: () => void;
  onImportCompany: (file: File) => void;
  onExportArchitecture: () => void;
  onImportArchitecture: (file: File) => void;
  onRetrospective: (employee: OpcEmployee) => void;
  onResetPersona: (employeeId: string) => void;
  onUpdateEmployee: (
    employeeId: string,
    patch: {
      status?: "active" | "paused";
      modelSelection?: { providerId: string; modelId: string };
    },
  ) => void;
  onDepart: (employeeId: string) => void;
}

export function OpcOrgView({
  state,
  onAddRoleSlot,
  onHire,
  onOpenGenerate,
  onOpenPresets,
  onExportCompany,
  onImportCompany,
  onExportArchitecture,
  onImportArchitecture,
  onRetrospective,
  onResetPersona,
  onUpdateEmployee,
  onDepart,
}: OpcOrgViewProps) {
  const { intl } = useZCodeIntl();
  // 员工级模型偏好编辑（providerId/modelId，格式同招聘对话框）与
  // 人格画像重置的两段确认状态。
  const [modelEditingId, setModelEditingId] = useState<string | null>(null);
  const [modelDraft, setModelDraft] = useState("");
  const [personaConfirmId, setPersonaConfirmId] = useState<string | null>(null);
  const [newSlotTitle, setNewSlotTitle] = useState("");
  const slotTitleByRoleId = useMemo(
    () => new Map(state.roleSlots.map((slot) => [slot.id, slot.title])),
    [state.roleSlots],
  );
  // 汇报线：员工 → 岗位 → 上级岗位 → 上级员工名（层级展示最小闭环）
  const managerNameByEmployeeId = useMemo(() => {
    const nameById = new Map(
      state.employees.map((employee) => [employee.id, employee.name]),
    );
    const slotById = new Map(state.roleSlots.map((slot) => [slot.id, slot]));
    return new Map(
      state.employees.flatMap((employee) => {
        const slot = employee.roleId
          ? slotById.get(employee.roleId)
          : undefined;
        const parentSlot =
          slot?.parentRoleId != null
            ? slotById.get(slot.parentRoleId)
            : undefined;
        const managerName = parentSlot?.employeeId
          ? nameById.get(parentSlot.employeeId)
          : undefined;
        return managerName ? [[employee.id, managerName] as const] : [];
      }),
    );
  }, [state.employees, state.roleSlots]);
  const skillsById = useMemo(
    () => new Map(state.skills.map((skill) => [skill.id, skill])),
    [state.skills],
  );
  const employees = state.employees.filter(
    (employee) => employee.status !== "departed",
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "opc.org.hint" })}
        </p>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={onOpenPresets}>
            {intl.formatMessage({ id: "opc.org.presets" })}
          </Button>
          <Button size="sm" variant="outline" onClick={onExportArchitecture}>
            {intl.formatMessage({ id: "opc.org.exportArchitecture" })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              document.getElementById("opc-import-architecture")?.click()
            }
          >
            {intl.formatMessage({ id: "opc.org.importArchitecture" })}
          </Button>
          <input
            id="opc-import-architecture"
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImportArchitecture(file);
              event.target.value = "";
            }}
          />
          <Button size="sm" variant="outline" onClick={onOpenGenerate}>
            {intl.formatMessage({ id: "opc.org.generate" })}
          </Button>
          <Button size="sm" variant="outline" onClick={onExportCompany}>
            {intl.formatMessage({ id: "opc.org.exportCompany" })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              document.getElementById("opc-import-company")?.click()
            }
          >
            {intl.formatMessage({ id: "opc.org.importCompany" })}
          </Button>
          <input
            id="opc-import-company"
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onImportCompany(file);
              event.target.value = "";
            }}
          />
          <Button size="sm" onClick={onHire}>
            <UserPlus className="size-4" />
            {intl.formatMessage({ id: "opc.org.hire" })}
          </Button>
        </div>
      </div>
      {state.roleSlots.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-xs text-foreground-faint">
            {intl.formatMessage({ id: "opc.org.roleSlots" })}
          </span>
          {state.roleSlots.map((slot) => {
            const holder = slot.employeeId
              ? state.employees.find(
                  (employee) => employee.id === slot.employeeId,
                )
              : null;
            return (
              <span
                key={slot.id}
                className="inline-flex items-center gap-1 rounded-full border border-card-border bg-card px-2 py-0.5 text-ui-xs text-foreground-subtle"
              >
                {slot.title}
                {holder ? (
                  <OpcEmployeeAvatar
                    employee={holder}
                    className="size-4 text-[10px]"
                  />
                ) : null}
              </span>
            );
          })}
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <Input
          value={newSlotTitle}
          onChange={(event) => setNewSlotTitle(event.target.value)}
          placeholder={intl.formatMessage({ id: "opc.org.newSlotPlaceholder" })}
          className="h-7 max-w-56"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const title = newSlotTitle.trim();
            if (!title) return;
            onAddRoleSlot(title);
            setNewSlotTitle("");
          }}
        >
          <Plus className="size-4" />
          {intl.formatMessage({ id: "opc.org.addSlot" })}
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {employees.map((employee) => (
            <div
              key={employee.id}
              className="flex flex-col gap-2 rounded-xl border border-card-border bg-card p-3"
            >
              <div className="flex items-start gap-2.5">
                <OpcEmployeeAvatar
                  employee={employee}
                  className="size-9 text-lg"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ui-sm font-medium text-foreground">
                    {employee.name}
                    {employee.isFallback ? (
                      <span className="ml-1.5 text-ui-xs text-foreground-faint">
                        {intl.formatMessage({ id: "opc.org.founderTag" })}
                      </span>
                    ) : null}
                  </p>
                  <p className="truncate text-ui-xs text-foreground-subtle">
                    {employee.category} · {employee.seniority}
                    {employee.roleId
                      ? ` · ${slotTitleByRoleId.get(employee.roleId) ?? ""}`
                      : ""}
                    {managerNameByEmployeeId.get(employee.id)
                      ? ` · ${intl.formatMessage(
                          { id: "opc.org.reportsTo" },
                          { name: managerNameByEmployeeId.get(employee.id)! },
                        )}`
                      : ""}
                    {employee.modelSelection
                      ? ` · ${intl.formatMessage(
                          { id: "opc.employee.model" },
                          {
                            model: `${employee.modelSelection.providerId}/${employee.modelSelection.modelId}`,
                          },
                        )}`
                      : ""}
                    {employee.permissionLevel &&
                    employee.permissionLevel !== "workspace-write"
                      ? ` · ${intl.formatMessage({
                          id: `opc.permission.${employee.permissionLevel}`,
                        })}`
                      : ""}
                  </p>
                </div>
              </div>
              {employee.vibe ? (
                <p className="line-clamp-1 text-ui-xs text-foreground-subtle">
                  「{employee.vibe}」
                </p>
              ) : null}
              {employee.skillRefs.length > 0 ? (
                <div className="flex flex-wrap gap-1">
                  {employee.skillRefs.map((skillId) => (
                    <span
                      key={skillId}
                      className="rounded bg-surface-hover px-1.5 py-0.5 text-ui-xs text-foreground-subtle"
                      title={skillsById.get(skillId)?.name ?? skillId}
                    >
                      {skillsById.get(skillId)?.name ?? skillId}
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="text-ui-xs tabular-nums text-foreground-faint">
                {intl.formatMessage(
                  {
                    id: "opc.org.stats",
                  },
                  {
                    completed: employee.stats.completed,
                    retrospectives: employee.stats.retrospectives,
                    lessons: employee.stats.lessons,
                  },
                )}
              </p>
              {modelEditingId === employee.id ? (
                <div className="flex flex-col gap-1">
                  <Input
                    value={modelDraft}
                    placeholder="providerId/modelId"
                    onChange={(event) => setModelDraft(event.target.value)}
                  />
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="xs"
                      variant="secondary"
                      onClick={() => {
                        const key = modelDraft.trim();
                        const parts = key.includes("/") ? key.split("/") : [];
                        const providerId = parts[0];
                        const modelId = parts.slice(1).join("/");
                        onUpdateEmployee(employee.id, {
                          modelSelection:
                            providerId && modelId
                              ? { providerId, modelId }
                              : undefined,
                        });
                        setModelEditingId(null);
                      }}
                    >
                      {intl.formatMessage({ id: "opc.org.modelSave" })}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => setModelEditingId(null)}
                    >
                      {intl.formatMessage({ id: "opc.org.cancel" })}
                    </Button>
                  </div>
                  <p className="text-ui-xs text-foreground-faint">
                    {intl.formatMessage({ id: "opc.org.modelHint" })}
                  </p>
                </div>
              ) : personaConfirmId === employee.id ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: "opc.org.personaResetConfirm" })}
                  </span>
                  <Button
                    size="xs"
                    variant="secondary"
                    onClick={() => {
                      onResetPersona(employee.id);
                      setPersonaConfirmId(null);
                    }}
                  >
                    {intl.formatMessage({ id: "opc.org.personaResetYes" })}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setPersonaConfirmId(null)}
                  >
                    {intl.formatMessage({ id: "opc.org.cancel" })}
                  </Button>
                </div>
              ) : null}
              <div className="mt-auto flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => onRetrospective(employee)}
                >
                  {intl.formatMessage({ id: "opc.org.retro" })}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setModelEditingId(
                      modelEditingId === employee.id ? null : employee.id,
                    );
                    setPersonaConfirmId(null);
                  }}
                >
                  {employee.modelSelection
                    ? `${intl.formatMessage({ id: "opc.org.model" })}: ${employee.modelSelection.modelId}`
                    : intl.formatMessage({ id: "opc.org.model" })}
                </Button>
                {employee.stats.retrospectives > 0 || employee.stats.completed > 0 ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="text-foreground-faint"
                    onClick={() =>
                      setPersonaConfirmId(
                        personaConfirmId === employee.id ? null : employee.id,
                      )
                    }
                  >
                    {intl.formatMessage({ id: "opc.org.personaReset" })}
                  </Button>
                ) : null}
                {employee.status === "active" ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      onUpdateEmployee(employee.id, { status: "paused" })
                    }
                  >
                    {intl.formatMessage({ id: "opc.org.pause" })}
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      onUpdateEmployee(employee.id, { status: "active" })
                    }
                  >
                    {intl.formatMessage({ id: "opc.org.resume" })}
                  </Button>
                )}
                {!employee.isFallback ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    className="ml-auto text-foreground-faint"
                    onClick={() => onDepart(employee.id)}
                  >
                    {intl.formatMessage({ id: "opc.org.depart" })}
                  </Button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
