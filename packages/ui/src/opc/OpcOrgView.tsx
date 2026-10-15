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
  onRetrospective: (employee: OpcEmployee) => void;
  onUpdateEmployee: (
    employeeId: string,
    patch: { status?: "active" | "paused" },
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
  onRetrospective,
  onUpdateEmployee,
  onDepart,
}: OpcOrgViewProps) {
  const { intl } = useZCodeIntl();
  const [newSlotTitle, setNewSlotTitle] = useState("");
  const slotTitleByRoleId = useMemo(
    () => new Map(state.roleSlots.map((slot) => [slot.id, slot.title])),
    [state.roleSlots],
  );
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
              <div className="mt-auto flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => onRetrospective(employee)}
                >
                  {intl.formatMessage({ id: "opc.org.retro" })}
                </Button>
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
