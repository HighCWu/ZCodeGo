/**
 * zcode-go OPC 草稿驾驶舱：OPC 模式下替代「问候语空态」的公司概览首页。
 * 只读投影 + 快捷操作（打开公司面板/新建工作项/招聘），委派等写操作都在面板内完成。
 */
import { useEffect, useMemo } from "react";
import { Building2, ClipboardList, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOpcStore } from "@/store/opcStore.js";
import {
  OpcEmployeeAvatar,
  OpcPriorityBadge,
  OPC_WORK_ITEM_STATUSES,
  opcStatusMessageId,
} from "./opcDisplay.js";
import { OPC_OPEN_PANEL_EVENT } from "./ZcodeGoOpcPanelRoot.js";

export function ZcodeGoOpcDraftHome({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string | null;
  workspaceIdentity?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const state = useOpcStore((s) => s.state);
  const loading = useOpcStore((s) => s.loading);
  const error = useOpcStore((s) => s.error);
  const initialize = useOpcStore((s) => s.initialize);

  useEffect(() => {
    if (workspacePath) {
      void initialize(workspacePath, workspaceIdentity ?? undefined);
    }
  }, [initialize, workspacePath, workspaceIdentity]);

  const openPanel = () => {
    window.dispatchEvent(new CustomEvent(OPC_OPEN_PANEL_EVENT));
  };

  const activeWorkItems = useMemo(
    () =>
      (state?.workItems ?? [])
        .filter(
          (item) => item.status === "in_progress" || item.status === "review",
        )
        .slice(0, 4),
    [state?.workItems],
  );
  const employeesById = useMemo(
    () =>
      new Map(
        (state?.employees ?? []).map((employee) => [employee.id, employee]),
      ),
    [state?.employees],
  );
  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of state?.workItems ?? []) {
      counts.set(item.status, (counts.get(item.status) ?? 0) + 1);
    }
    return counts;
  }, [state?.workItems]);

  if (error === "ipc-unavailable") {
    return (
      <div className="flex w-full max-w-2xl flex-col items-center gap-3 text-center">
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "opc.home.ipcUnavailable" })}
        </p>
      </div>
    );
  }
  if (!state) {
    return (
      <div className="flex w-full max-w-2xl flex-col items-center gap-3 text-center">
        <p className="text-ui-sm text-foreground-faint">
          {loading
            ? intl.formatMessage({ id: "opc.home.loading" })
            : intl.formatMessage({ id: "opc.home.unavailable" })}
        </p>
      </div>
    );
  }

  const activeEmployees = state.employees.filter(
    (employee) => employee.status === "active",
  );

  return (
    <div
      className="flex w-full max-w-2xl flex-col gap-5"
      data-zcode-go-opc-home="true"
    >
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-xl">
          🏛️
        </span>
        <div className="min-w-0 flex-1 text-left">
          <p className="truncate text-ui-lg font-medium text-foreground">
            {state.company.name}
          </p>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage(
              {
                id: "opc.home.summary",
              },
              {
                employees: activeEmployees.length,
                workItems: state.workItems.length,
                skills: state.skills.length,
              },
            )}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={openPanel}>
          <Building2 className="size-4" />
          {intl.formatMessage({ id: "opc.home.openPanel" })}
        </Button>
        <Button size="sm" variant="outline" onClick={openPanel}>
          <ClipboardList className="size-4" />
          {intl.formatMessage({ id: "opc.home.newWorkItem" })}
        </Button>
        <Button size="sm" variant="outline" onClick={openPanel}>
          <UserPlus className="size-4" />
          {intl.formatMessage({ id: "opc.home.hire" })}
        </Button>
      </div>
      {state.workItems.length > 0 ? (
        <div className="flex flex-col gap-2 text-left">
          <div className="flex items-center gap-3">
            <span className="text-ui-xs font-medium text-foreground-faint">
              {intl.formatMessage({ id: "opc.home.kanbanTitle" })}
            </span>
            <div className="flex items-center gap-2">
              {OPC_WORK_ITEM_STATUSES.map((status) => (
                <span key={status} className="text-ui-xs text-foreground-faint">
                  {intl.formatMessage({ id: opcStatusMessageId(status) })}
                  <span className="ml-0.5 tabular-nums text-foreground-subtle">
                    {statusCounts.get(status) ?? 0}
                  </span>
                </span>
              ))}
            </div>
          </div>
          {activeWorkItems.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              {activeWorkItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={openPanel}
                  className="flex items-center gap-2 rounded-lg border border-card-border bg-card px-2.5 py-1.5 text-left transition-colors hover:border-border-hover"
                >
                  <OpcEmployeeAvatar
                    employee={
                      item.assigneeId
                        ? (employeesById.get(item.assigneeId) ?? null)
                        : null
                    }
                    className="size-5 text-xs"
                  />
                  <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground">
                    {item.title}
                  </span>
                  <OpcPriorityBadge priority={item.priority} />
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-left text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "opc.home.emptyCompany" })}
        </p>
      )}
    </div>
  );
}
